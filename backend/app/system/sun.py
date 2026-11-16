"""Sunrise/sunset (NOAA algorithm) and the light/dark appearance schedule."""

from __future__ import annotations

import math
from datetime import UTC, date, datetime, time, timedelta
from zoneinfo import ZoneInfo

from app.config import AppearanceConfig, LocationConfig

ZENITH = 90.833  # official, includes refraction and solar disc


def _sun_event(day: date, lat: float, lon: float, rising: bool) -> datetime | None:
    n = day.timetuple().tm_yday
    lng_hour = lon / 15
    t = n + ((6 if rising else 18) - lng_hour) / 24
    m = 0.9856 * t - 3.289
    sun_l = (m + 1.916 * math.sin(math.radians(m)) + 0.020 * math.sin(math.radians(2 * m)) + 282.634) % 360
    ra = math.degrees(math.atan(0.91764 * math.tan(math.radians(sun_l)))) % 360
    ra = (ra + (math.floor(sun_l / 90) * 90 - math.floor(ra / 90) * 90)) / 15
    sin_dec = 0.39782 * math.sin(math.radians(sun_l))
    cos_dec = math.cos(math.asin(sin_dec))
    cos_h = (math.cos(math.radians(ZENITH)) - sin_dec * math.sin(math.radians(lat))) / (
        cos_dec * math.cos(math.radians(lat))
    )
    if not -1 <= cos_h <= 1:
        return None  # polar day/night
    h = (360 - math.degrees(math.acos(cos_h))) if rising else math.degrees(math.acos(cos_h))
    local_t = h / 15 + ra - 0.06571 * t - 6.622
    ut = (local_t - lng_hour) % 24
    return datetime.combine(day, time(0), UTC) + timedelta(hours=ut)


def sun_times(day: date, loc: LocationConfig) -> tuple[datetime | None, datetime | None]:
    return _sun_event(day, loc.latitude, loc.longitude, True), _sun_event(day, loc.latitude, loc.longitude, False)


def _fixed(day: date, hhmm: str, tz: ZoneInfo) -> datetime:
    hh, mm = (int(x) for x in hhmm.split(":"))
    return datetime.combine(day, time(hh, mm), tz).astimezone(UTC)


def appearance_now(
    app: AppearanceConfig, loc: LocationConfig, override: str | None = None, now: datetime | None = None
) -> dict[str, object]:
    """Resolve current mode and when it next changes (UTC ISO)."""
    now = now or datetime.now(UTC)
    mode = override or app.mode
    if mode in {"light", "dark"}:
        return {"mode": mode, "source": "manual", "next_switch": None}
    tz = ZoneInfo(loc.timezone)
    local_day = now.astimezone(tz).date()
    events: list[tuple[datetime, str]] = []
    for d in (local_day - timedelta(days=1), local_day, local_day + timedelta(days=1)):
        rise: datetime | None
        set_: datetime | None
        if app.auto_source == "fixed":
            rise, set_ = _fixed(d, app.light_at, tz), _fixed(d, app.dark_at, tz)
        else:
            rise, set_ = sun_times(d, loc)
        if rise:
            events.append((rise, "light"))
        if set_:
            events.append((set_, "dark"))
    events.sort()
    past = [e for e in events if e[0] <= now]
    future = [e for e in events if e[0] > now]
    current = past[-1][1] if past else "dark"
    nxt = future[0][0].isoformat() if future else None
    return {"mode": current, "source": app.auto_source, "next_switch": nxt}
