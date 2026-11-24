import re

_DURATION_RE = re.compile(r'^(?:(0|[1-9]\d*)h)?(?:(0|[1-9]\d*)m)?(?:(0|[1-9]\d*)s)?$')


def parse_duration(s: str) -> int:
    """Convert a duration string like '1h2m3s' to total seconds."""
    # bool is a subclass of int/str-adjacent; reject it before the str check.
    if isinstance(s, bool):
        raise TypeError('s must be str, not bool')
    if not isinstance(s, str):
        raise TypeError('s must be str')
    m = _DURATION_RE.fullmatch(s)
    if m is None:
        raise ValueError(f'invalid duration: {s!r}')
    h, mi, se = m.groups()
    # fullmatch on the all-optional pattern also accepts '' -> all None (zero units).
    if h is None and mi is None and se is None:
        raise ValueError(f'invalid duration: {s!r}')
    total = 0
    if h is not None:
        total += int(h) * 3600
    if mi is not None:
        total += int(mi) * 60
    if se is not None:
        total += int(se)
    return total


def format_duration(sec: int) -> str:
    """Convert total seconds to a normalized '1h2m3s' string."""
    # bool before int: True/False are int subclasses and must raise TypeError.
    if isinstance(sec, bool):
        raise TypeError('sec must be int, not bool')
    if not isinstance(sec, int):
        raise TypeError('sec must be int')
    if sec < 0:
        raise ValueError('sec must be >= 0')
    if sec == 0:
        return '0s'
    h = sec // 3600
    m = (sec % 3600) // 60
    s = sec % 60
    parts = []
    if h:
        parts.append(f'{h}h')
    if m:
        parts.append(f'{m}m')
    if s:
        parts.append(f'{s}s')
    return ''.join(parts)


def add_durations(a: str, b: str) -> str:
    """Add two duration strings, returning the normalized result."""
    return format_duration(parse_duration(a) + parse_duration(b))
