#!/usr/bin/env python3
"""S2 外部知見クロールの Python サイドカー（D7）。

役割:
  stdin で URL を改行区切りで受け取り、各 URL を取得して
  {url, title, kind, text, error?} の JSON 配列を stdout に出す CLI。

依存方針（CLAUDE.md「Python は標準ライブラリ優先」/ 仕様「依存を強制しない」）:
  - Scrapling があれば使う（JS レンダ込みの堅牢な取得）。
  - 無ければ urllib（標準ライブラリ）にフォールバック。
  - import で分岐し、Scrapling 未インストールでも単体で動く。

堅牢性:
  - robots.txt 不許可・タイムアウト・取得失敗は例外を投げず error フィールドに入れる
    （partial-first: 1 URL の失敗で全体を止めない / CLAUDE.md「単一ワーカーの失敗で
    ループを止めない」と同じ思想）。
  - 標準出力には JSON 配列のみを出す（TS 側が JSON.parse する契約）。
    診断ログは stderr へ。

出力契約（1 要素 = 1 URL、入力順を保持）:
  {
    "url":   "<入力 URL>",
    "title": "<ページタイトル / 空文字可>",
    "kind":  "web" | "paper" | "arxiv",
    "text":  "<本文テキスト / 空文字可>",
    "error": "<失敗理由（成功時はキー自体を出さない）>"
  }
"""
from __future__ import annotations

import json
import re
import sys
from typing import Optional
from urllib.parse import urlparse

# 取得のハード timeout（秒）。TS 側のプロセス timeout とは別に、
# 1 URL あたりの取得が固まらないよう内側にも持つ。
FETCH_TIMEOUT_S = 20

# arxiv 判定（ホスト一致）。論文 PDF は拡張子で paper 判定。
_ARXIV_HOST_RE = re.compile(r"(^|\.)arxiv\.org$", re.IGNORECASE)
_TITLE_RE = re.compile(r"<title[^>]*>(.*?)</title>", re.IGNORECASE | re.DOTALL)
_TAG_RE = re.compile(r"<[^>]+>")
_SCRIPT_STYLE_RE = re.compile(
    r"<(script|style)[^>]*>.*?</\1>", re.IGNORECASE | re.DOTALL
)
_WS_RE = re.compile(r"\s+")


def classify_kind(url: str) -> str:
    """URL から kind を推定（CrawledUrl.kind = "web" | "paper" | "arxiv"）。"""
    try:
        host = (urlparse(url).hostname or "").lower()
        path = (urlparse(url).path or "").lower()
    except Exception:
        return "web"
    if _ARXIV_HOST_RE.search(host):
        return "arxiv"
    if path.endswith(".pdf"):
        return "paper"
    return "web"


def _extract_title(html: str) -> str:
    """<title> を抽出（無ければ空文字）。"""
    m = _TITLE_RE.search(html)
    if not m:
        return ""
    return _WS_RE.sub(" ", _strip_tags(m.group(1))).strip()


def _strip_tags(html: str) -> str:
    """script/style を捨て、タグを除去して可読テキストにする（簡易）。"""
    no_blocks = _SCRIPT_STYLE_RE.sub(" ", html)
    no_tags = _TAG_RE.sub(" ", no_blocks)
    return no_tags


def _html_to_text(html: str) -> str:
    """HTML から本文テキストを抽出（簡易・標準ライブラリのみ）。"""
    text = _strip_tags(html)
    # HTML エンティティの最低限の復元（標準 html モジュール使用）。
    try:
        import html as html_mod

        text = html_mod.unescape(text)
    except Exception:
        pass
    return _WS_RE.sub(" ", text).strip()


def _read_urls(stream) -> list[str]:
    """stdin（改行区切り）から URL を読む。空行・前後空白は無視。"""
    urls: list[str] = []
    for line in stream:
        u = line.strip()
        if u:
            urls.append(u)
    return urls


# ───────── 取得バックエンド ─────────


def _fetch_scrapling(url: str) -> Optional[tuple[str, str]]:
    """Scrapling で取得。利用不可なら None を返し、呼び出し側がフォールバック。

    戻り: (title, text) もしくは取得失敗で例外。利用不可（import 不可）は None。
    """
    try:
        from scrapling.fetchers import Fetcher  # type: ignore
    except Exception:
        return None  # 未インストール → urllib にフォールバック

    page = Fetcher.get(url, timeout=FETCH_TIMEOUT_S)
    title = ""
    text = ""
    try:
        # Scrapling の API 差異に頑健に: 取れるものから取る。
        title_el = page.css_first("title")
        if title_el is not None:
            title = (getattr(title_el, "text", "") or "").strip()
        body = getattr(page, "get_all_text", None)
        if callable(body):
            text = (page.get_all_text() or "").strip()
        else:
            text = _html_to_text(str(getattr(page, "html_content", "") or page))
    except Exception:
        # パースだけ失敗しても本文 raw から復旧を試みる。
        text = _html_to_text(str(getattr(page, "html_content", "") or ""))
    return (title, _WS_RE.sub(" ", text).strip())


def _fetch_urllib(url: str) -> tuple[str, str]:
    """標準ライブラリ urllib で取得（フォールバック）。"""
    import urllib.error
    import urllib.request

    req = urllib.request.Request(
        url,
        headers={
            # 既定 UA はブロックされがちなので穏当な UA を付ける。
            "User-Agent": "Mozilla/5.0 (compatible; Taikai-killer-crawl/1.0)"
        },
    )
    with urllib.request.urlopen(req, timeout=FETCH_TIMEOUT_S) as resp:
        raw = resp.read()
        charset = resp.headers.get_content_charset() or "utf-8"
    html = raw.decode(charset, errors="replace")
    return (_extract_title(html), _html_to_text(html))


# ───────── robots.txt ─────────


def _robots_allows(url: str) -> bool:
    """robots.txt が当該 UA に取得を許すか。判定不能時は許可寄り（True）。

    robots そのものの取得に失敗したら、クロールを止めずに許可とみなす
    （仕様: robots は error に記録、ただし取得不能 robots でブロックしない）。
    """
    try:
        import urllib.robotparser

        parts = urlparse(url)
        if not parts.scheme or not parts.netloc:
            return True
        robots_url = f"{parts.scheme}://{parts.netloc}/robots.txt"
        rp = urllib.robotparser.RobotFileParser()
        rp.set_url(robots_url)
        rp.read()
        return rp.can_fetch("*", url)
    except Exception:
        return True


def fetch_one(url: str) -> dict:
    """1 URL を取得して出力契約の dict を返す（例外は投げない）。"""
    record: dict = {"url": url, "title": "", "kind": classify_kind(url), "text": ""}

    # robots チェック（不許可は取得せず error に）。
    if not _robots_allows(url):
        record["error"] = "robots_disallowed"
        return record

    try:
        result = _fetch_scrapling(url)
        if result is None:
            result = _fetch_urllib(url)
        title, text = result
        record["title"] = title or ""
        record["text"] = text or ""
    except Exception as e:  # noqa: BLE001 — 失敗は error に集約（停止しない）
        record["error"] = f"{type(e).__name__}: {e}"
    return record


def crawl(urls: list[str]) -> list[dict]:
    """全 URL を順に取得（入力順保持）。"""
    return [fetch_one(u) for u in urls]


def main() -> int:
    urls = _read_urls(sys.stdin)
    results = crawl(urls)
    # stdout には JSON 配列のみ（TS 側 JSON.parse 契約）。
    json.dump(results, sys.stdout, ensure_ascii=False)
    sys.stdout.write("\n")
    sys.stdout.flush()
    return 0


if __name__ == "__main__":
    sys.exit(main())
