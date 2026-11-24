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
import json
import sys
from PIL import Image, ImageDraw, ImageFont

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

    # ---- token identity ----
    title = fit_text(draw, name, f_title, 620)
    draw.text((64, 168), title, font=f_title, fill=(255, 255, 255))
    sub = fit_text(draw, f"{symbol} · {chain}".strip(" ·"), f_sub, 620)
    draw.text((64, 228), sub, font=f_sub, fill=MUTED)

    # ---- headline ROI (right aligned) ----
    colour = tone_for(mult)
    roi_text = payload.get("multipleLabel") or "n/a"
    rw = draw.textlength(roi_text, font=f_huge)
    draw.text((W - 64 - rw, 132), roi_text, font=f_huge, fill=colour)
    if pct:
        pw = draw.textlength(pct, font=f_mono)
        draw.text((W - 64 - pw, 222), pct, font=f_mono, fill=colour)

    # ---- caller + peak multiple ----
    draw.text((64, 284), f"Called by {caller}", font=f_small, fill=TEXT)
    if peak_observed and peak_mult:
        pm = f"peak {peak_mult}"
        pw2 = draw.textlength(pm, font=f_mono)
        draw.text((W - 64 - pw2, 284), pm, font=f_mono, fill=MUTED)

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
