#!/usr/bin/env python
"""
scripts/render_pnl.py
Render the Meme Checker PnL card to PNG.

Reads a JSON payload on stdin, writes a PNG to the path given as argv[1].

Why Python + Pillow: it is already present in this environment and produces a
real raster PNG that Telegram accepts as a photo. The alternative (SVG) is not
displayed inline by Telegram, and pulling in a headless browser or a native
rasteriser for one card is not justified.

The layout deliberately mirrors src/pnl-card.mjs so the text card and the image
card cannot drift apart in what they claim.
"""
import io
import json
import os
import ssl
import sys
import urllib.request
from PIL import Image, ImageDraw, ImageFont

# Logo fetching is deliberately narrow: https only, hard size cap, short timeout,
# and a quiet fallback. A missing or hostile image must never break the card.
LOGO_TIMEOUT = 6
LOGO_MAX_BYTES = 2 * 1024 * 1024
LOGO_MAX_PX = 512


def fetch_logo(url, cache_dir=None):
    """Return a PIL image for a logo URL, or None. Never raises."""
    if not url or not isinstance(url, str):
        return None
    if not url.lower().startswith('https://'):
        return None
    try:
        req = urllib.request.Request(url, headers={'User-Agent': 'MemeChecker/1.0'})
        ctx = ssl.create_default_context()
        with urllib.request.urlopen(req, timeout=LOGO_TIMEOUT, context=ctx) as resp:
            ctype = (resp.headers.get('Content-Type') or '').split(';')[0].strip().lower()
            if ctype and not ctype.startswith('image/'):
                return None
            data = resp.read(LOGO_MAX_BYTES + 1)
        if len(data) > LOGO_MAX_BYTES:
            return None
        img = Image.open(io.BytesIO(data))
        img.load()
        if img.mode not in ('RGB', 'RGBA'):
            img = img.convert('RGBA')
        if max(img.size) > LOGO_MAX_PX:
            img.thumbnail((LOGO_MAX_PX, LOGO_MAX_PX), Image.LANCZOS)
        return img
    except Exception:
        return None


def paste_logo(canvas, logo, box):
    """Draw a circular logo at box=(x, y, size). No-op when absent."""
    if logo is None:
        return False
    x, y, size = box
    try:
        art = logo.copy()
        art = art.convert('RGBA')
        # Cover-crop so a non-square logo is not distorted.
        w, h = art.size
        side = min(w, h)
        art = art.crop(((w - side) // 2, (h - side) // 2, (w + side) // 2, (h + side) // 2))
        art = art.resize((size, size), Image.LANCZOS)

        mask = Image.new('L', (size * 4, size * 4), 0)
        ImageDraw.Draw(mask).ellipse((0, 0, size * 4 - 1, size * 4 - 1), fill=255)
        mask = mask.resize((size, size), Image.LANCZOS)

        canvas.paste(art, (x, y), mask)
        # subtle ring
        ImageDraw.Draw(canvas).ellipse(
            (x - 1, y - 1, x + size, y + size), outline=(60, 78, 96), width=2)
        return True
    except Exception:
        return False

W, H = 1000, 620
BG_TOP = (18, 26, 36)
BG_BOT = (11, 17, 24)
ACCENT = (106, 179, 243)
MUTED = (143, 163, 184)
TEXT = (233, 237, 241)
DIM = (93, 115, 135)
LINE = (34, 48, 61)

GREEN = (46, 204, 113)
LIME = (126, 211, 33)
WHITE = (201, 209, 217)
AMBER = (240, 160, 42)
RED = (231, 76, 60)


def load_font(size, bold=False):
    """Pick a real font; fall back gracefully rather than crashing."""
    candidates = []
    if bold:
        candidates += [
            "C:/Windows/Fonts/segoeuib.ttf",
            "C:/Windows/Fonts/arialbd.ttf",
            "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf",
        ]
    candidates += [
        "C:/Windows/Fonts/segoeui.ttf",
        "C:/Windows/Fonts/arial.ttf",
        "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
    ]
    for path in candidates:
        try:
            return ImageFont.truetype(path, size)
        except Exception:
            continue
    return ImageFont.load_default()


def load_mono(size):
    for path in [
        "C:/Windows/Fonts/consola.ttf",
        "C:/Windows/Fonts/cour.ttf",
        "/usr/share/fonts/truetype/dejavu/DejaVuSansMono.ttf",
    ]:
        try:
            return ImageFont.truetype(path, size)
        except Exception:
            continue
    return load_font(size)


def tone_for(mult):
    if mult is None:
        return MUTED
    if mult >= 2:
        return GREEN
    if mult >= 1.05:
        return LIME
    if mult >= 0.95:
        return WHITE
    if mult >= 0.5:
        return AMBER
    return RED


def vertical_gradient(w, h, top, bottom):
    img = Image.new("RGB", (1, h))
    px = img.load()
    for y in range(h):
        t = y / max(1, h - 1)
        px[0, y] = tuple(int(top[i] + (bottom[i] - top[i]) * t) for i in range(3))
    return img.resize((w, h))


def fit_text(draw, text, font, max_width):
    """Truncate with an ellipsis to fit max_width pixels."""
    if draw.textlength(text, font=font) <= max_width:
        return text
    while text and draw.textlength(text + "…", font=font) > max_width:
        text = text[:-1]
    return text + "…"


def main():
    out_path = sys.argv[1]
    payload = json.load(sys.stdin)

    name = payload.get("name") or "Token"
    symbol = payload.get("symbol") or ""
    chain = payload.get("chain") or ""
    caller = payload.get("caller") or "unknown caller"
    age = payload.get("ageLabel") or ""
    entry = payload.get("entryMarketCap") or "—"
    current = payload.get("currentMarketCap") or "not observed yet"
    peak = payload.get("peakMarketCap") or "no higher observation"
    mult = payload.get("multiple")
    pct = payload.get("percent") or ""
    peak_mult = payload.get("peakMultiple")
    peak_observed = bool(payload.get("peakIsObserved"))
    group_title = payload.get("groupTitle") or ""
    peak_pct = payload.get("peakPercent") or ""
    logo_url = payload.get("logoUrl")
    disclaimer = payload.get(
        "disclaimer",
        "Price ratio since the call, not realized profit. "
        "Peak = highest observed since this call, not all-time high.",
    )

    img = vertical_gradient(W, H, BG_TOP, BG_BOT)
    draw = ImageDraw.Draw(img)

    # Top accent bar
    for x in range(W):
        t = x / (W - 1)
        r = int(106 + (155 - 106) * t)
        g = int(179 + (106 - 179) * t)
        b = int(243 + (243 - 243) * t)
        draw.line([(x, 0), (x, 4)], fill=(r, g, b))

    f_brand = load_font(26, bold=True)
    f_kicker = load_font(14)
    f_small = load_font(17)
    f_mono = load_mono(22)
    f_title = load_font(46, bold=True)
    f_sub = load_mono(19)
    f_huge = load_font(78, bold=True)
    f_tiny = load_font(14)

    # ---- header ----
    draw.text((64, 48), "MEME CHECKER", font=f_brand, fill=(255, 255, 255))
    draw.text((64, 84), "CALL PERFORMANCE", font=f_kicker, fill=ACCENT)
    if age:
        t = f"{age} ago"
        w = draw.textlength(t, font=f_small)
        draw.text((W - 64 - w, 52), t, font=f_small, fill=MUTED)

    # ---- token identity (logo-aware) ----
    logo = fetch_logo(logo_url) if logo_url else None
    logo_drawn = paste_logo(img, logo, (64, 152, 84)) if logo else False
    tx = 64 + (84 + 22 if logo_drawn else 0)
    text_w = 620 - (84 + 22 if logo_drawn else 0)

    title = fit_text(draw, name, f_title, text_w)
    draw.text((tx, 158), title, font=f_title, fill=(255, 255, 255))
    sub_line = f"{symbol} · {chain}".strip(" ·")
    if group_title:
        sub_line = f"{sub_line} · {group_title}" if sub_line else group_title
    sub = fit_text(draw, sub_line, f_sub, text_w)
    draw.text((tx, 218), sub, font=f_sub, fill=MUTED)

    # ---- headline ROI (right aligned) ----
    colour = tone_for(mult)
    roi_text = payload.get("multipleLabel") or "—"
    rw = draw.textlength(roi_text, font=f_huge)
    draw.text((W - 64 - rw, 132), roi_text, font=f_huge, fill=colour)
    draw.text((W - 64 - draw.textlength("CURRENT ROI", font=f_kicker), 118),
              "CURRENT ROI", font=f_kicker, fill=DIM)
    if pct:
        pw = draw.textlength(pct, font=f_mono)
        draw.text((W - 64 - pw, 222), pct, font=f_mono, fill=colour)

    # ---- labelled ROI pair (current vs peak, explicitly distinguished) ----
    # The big number is CURRENT. Peak sits beside it with its own label so the two
    # can never be read as the same figure.
    # The big number above IS the current ROI, so only the peak needs its own
    # labelled column here — repeating current would read as a second figure.
    lbl_x = W - 64
    if peak_observed and peak_mult:
        draw.text((lbl_x - 150, 300), "PEAK ROI", font=f_tiny, fill=DIM)
        draw.text((lbl_x - 150, 318), fit_text(draw, peak_mult, f_mono, 130), font=f_mono, fill=MUTED)

    # ---- caller + peak multiple ----
    caller_line = f"Called by {caller}"
    draw.text((64, 284), fit_text(draw, caller_line, f_small, 560), font=f_small, fill=TEXT)

    # ---- divider ----
    draw.line([(64, 320), (W - 64, 320)], fill=LINE, width=1)

    # ---- metric rows ----
    rows = [
        ("Entry MC", entry),
        ("Current MC", current),
        ("Peak MC (since call)", peak),
    ]
    y = 352
    for label, value in rows:
        draw.text((64, y), label, font=f_mono, fill=MUTED)
        vw = draw.textlength(str(value), font=f_mono)
        draw.text((W - 64 - vw, y), str(value), font=f_mono, fill=TEXT)
        y += 52

    # ---- disclaimer ----
    draw.line([(64, H - 92), (W - 64, H - 92)], fill=LINE, width=1)
    for i, chunk in enumerate(_wrap(draw, disclaimer, f_tiny, W - 128)):
        draw.text((64, H - 76 + i * 20), chunk, font=f_tiny, fill=DIM)

    img.save(out_path, "PNG", optimize=True)


def _wrap(draw, text, font, max_width):
    words = text.split()
    lines, cur = [], ""
    for w in words:
        trial = (cur + " " + w).strip()
        if draw.textlength(trial, font=font) <= max_width:
            cur = trial
        else:
            if cur:
                lines.append(cur)
            cur = w
    if cur:
        lines.append(cur)
    return lines[:3]


if __name__ == "__main__":
    main()
