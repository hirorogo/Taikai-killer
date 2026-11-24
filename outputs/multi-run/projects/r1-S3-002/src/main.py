def parse_duration(s):
    """Parse a duration string like '1h2m3s' into total seconds (handwritten scanner)."""
    if isinstance(s, bool) or not isinstance(s, str):
        raise TypeError("parse_duration expects str")
    if s == "":
        raise ValueError("empty string")
    units = {'h': 3600, 'm': 60, 's': 1}
    order = {'h': 0, 'm': 1, 's': 2}
    i = 0
    n = len(s)
    last_idx = -1
    total = 0
    found = False
    while i < n:
        start = i
        while i < n and '0' <= s[i] <= '9':
            i += 1
        digits = s[start:i]
        if digits == "":
            raise ValueError("expected digits at position %d" % i)
        if len(digits) > 1 and digits[0] == '0':
            raise ValueError("leading zero not allowed: %r" % digits)
        if i >= n:
            raise ValueError("number without unit")
        unit = s[i]
        if unit not in units:
            raise ValueError("unknown unit: %r" % unit)
        idx = order[unit]
        if idx <= last_idx:
            raise ValueError("unit out of order or duplicated: %r" % unit)
        last_idx = idx
        total += int(digits) * units[unit]
        found = True
        i += 1
    if not found:
        raise ValueError("no units found")
    return total


def format_duration(sec):
    """Format total seconds into a normalized '1h2m3s' string."""
    if isinstance(sec, bool) or not isinstance(sec, int):
        raise TypeError("format_duration expects int")
    if sec < 0:
        raise ValueError("sec must be non-negative")
    if sec == 0:
        return "0s"
    h = sec // 3600
    rem = sec % 3600
    m = rem // 60
    s = rem % 60
    parts = []
    if h:
        parts.append("%dh" % h)
    if m:
        parts.append("%dm" % m)
    if s:
        parts.append("%ds" % s)
    return "".join(parts)


def add_durations(a, b):
    """Add two duration strings, returning a normalized duration string."""
    return format_duration(parse_duration(a) + parse_duration(b))
