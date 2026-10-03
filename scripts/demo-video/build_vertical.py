"""Vertical (9:16, 1080x1920) cut for social media, from a recording made
with `record.mjs --vertical`: a 1080x1080 window onto the app that pans
with the cursor, the caption large above it and the call to action below.

    python scripts/demo-video/build_vertical.py   -> out/tenvy-demo-vertical.mp4
"""
import json, math, os, shutil, subprocess
from PIL import Image, ImageDraw, ImageFont

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, 'out')
REPO = os.path.join(HERE, '..', '..')
FPS = 30
SCALE = 1.2                      # CSS px -> frame px (see record.mjs)
SRC_W, SRC_H = 1920, 1080
W, H = 1080, 1920
TOP = 420                        # app window sits at y = TOP .. TOP + 1080
GOLD = (212, 180, 124)

frames = json.load(open(os.path.join(OUT, 'frames.json')))
frames = [f for f in frames if f['t'] >= frames[0]['t'] + 0.4] or frames
events = json.load(open(os.path.join(OUT, 'events.json')))
t0 = frames[0]['t']
dur = frames[-1]['t'] - t0 + 2.5
n = math.ceil(dur * FPS) + 1

# Where the caption wants the window when the cursor isn't the story.
FOCUS = {'Find anything, instantly': SRC_W / 2}

font = lambda name, size: ImageFont.truetype(os.path.join(os.environ['WINDIR'], 'Fonts', name), size)
F_CAP = font('seguisb.ttf', 64)
F_BRAND = font('seguisb.ttf', 40)
F_PILL = font('seguisb.ttf', 40)
F_URL = font('segoeui.ttf', 30)
logo = Image.open(os.path.join(REPO, 'src-tauri', 'icons', '128x128.png')).convert('RGBA').resize((64, 64), Image.LANCZOS)


def cursor_at(t):
    """Cursor x in frame px at time t, following the recorded moves."""
    x = 1600 * 0.62
    for e in events:
        if e['type'] != 'cursor' or e['t'] > t:
            continue
        k = min(1.0, (t - e['t']) / max(e['ms'] / 1000, 0.001))
        k = k * k * (3 - 2 * k)
        x = x + (e['x'] - x) * k
    return x * SCALE


def state_at(t):
    caption, cards, since = None, True, t0
    for e in events:
        if e['t'] > t:
            break
        if e['type'] == 'caption':
            caption, since = e['text'], e['t']
        elif e['type'] == 'card':
            cards = e['on']
    return caption, cards, since


def background():
    bg = Image.new('RGB', (W, H), (10, 10, 10))
    glow = Image.new('L', (W, H), 0)
    d = ImageDraw.Draw(glow)
    for r in range(520, 0, -8):
        d.ellipse((W / 2 - r * 1.4, 120 - r * 0.7, W / 2 + r * 1.4, 120 + r * 0.7), fill=int(34 * (1 - r / 520)))
    bg.paste(Image.new('RGB', (W, H), GOLD), (0, 0), glow)
    d = ImageDraw.Draw(bg)
    # Brand
    brand_w = 64 + 18 + d.textlength('Tenvy', font=F_BRAND)
    x = (W - brand_w) / 2
    bg.paste(logo, (int(x), 72), logo)
    d.text((x + 82, 104), 'Tenvy', font=F_BRAND, fill=(245, 245, 245), anchor='lm')
    # Call to action
    pill = 'Free for Windows'
    pw = d.textlength(pill, font=F_PILL) + 72
    d.rounded_rectangle(((W - pw) / 2, 1610, (W + pw) / 2, 1700), radius=20, fill=GOLD)
    d.text((W / 2, 1655), pill, font=F_PILL, fill=(10, 10, 10), anchor='mm')
    d.text((W / 2, 1770), 'quph4.github.io/tenvy-releases', font=F_URL, fill=(140, 140, 140), anchor='mm')
    # Hairlines around the app window
    d.line((0, TOP - 1, W, TOP - 1), fill=(40, 36, 30))
    d.line((0, TOP + 1080, W, TOP + 1080), fill=(40, 36, 30))
    return bg


def wrap(text, width):
    words, lines = text.split(), ['']
    d = ImageDraw.Draw(Image.new('L', (1, 1)))
    for w in words:
        trial = (lines[-1] + ' ' + w).strip()
        if d.textlength(trial, font=F_CAP) <= width:
            lines[-1] = trial
        else:
            lines.append(w)
    return lines


BG = background()
seq = os.path.join(OUT, 'vseq')
shutil.rmtree(seq, ignore_errors=True)
os.makedirs(seq)

j, x0 = 0, (SRC_W - 1080) / 2
for k in range(n):
    t = t0 + k / FPS
    while j + 1 < len(frames) and frames[j + 1]['t'] <= t:
        j += 1
    caption, cards, since = state_at(t)
    target = SRC_W / 2 if cards else FOCUS.get(caption, cursor_at(t))
    target = min(max(target - 540, 0), SRC_W - 1080)
    x0 += (target - x0) * (1 - math.exp(-1 / FPS / 0.45))   # smooth pan

    src = Image.open(os.path.join(OUT, 'frames', frames[j]['name']))
    canvas = BG.copy()
    canvas.paste(src.crop((int(x0), 0, int(x0) + 1080, SRC_H)), (0, TOP))
    if caption and not cards:
        alpha = min(1.0, (t - since) / 0.35)
        layer = Image.new('RGBA', (W, TOP), (0, 0, 0, 0))
        d = ImageDraw.Draw(layer)
        lines = wrap(caption, 940)
        y = 270 - (len(lines) - 1) * 38
        for line in lines:
            d.text((W / 2, y + (1 - alpha) * 14), line, font=F_CAP, fill=(245, 240, 230, int(255 * alpha)), anchor='mm')
            y += 76
        canvas.paste(layer, (0, 0), layer)
    canvas.save(os.path.join(seq, f'v{k:05d}.jpg'), quality=90)

print(f'{n} frames, {n / FPS:.1f}s')
mpv = os.path.join(REPO, 'src-tauri', 'resources', 'mpv', 'mpv.exe')
out = os.path.join(OUT, 'tenvy-demo-vertical.mp4')
subprocess.run([
    mpv, f'mf://{seq}/*.jpg', f'--mf-fps={FPS}', '--no-config', '--no-audio',
    f'--o={out}', '--of=mp4', '--ovc=libx264', '--vf=format=yuv420p',
    '--ovcopts=crf=21,preset=slow,profile=high,movflags=+faststart',
], check=True, stdout=subprocess.DEVNULL)
print(out, os.path.getsize(out) // 1024, 'KB')
