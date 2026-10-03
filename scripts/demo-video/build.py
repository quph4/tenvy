"""Turn screencast frames (variable rate) into a constant 30 fps sequence,
a contact sheet for review, and (with --encode) an H.264 MP4 via mpv."""
import json, math, os, shutil, subprocess, sys
from PIL import Image

HERE = os.path.dirname(os.path.abspath(__file__))
DIR = os.path.join(HERE, 'out')
FPS = 30
frames = json.load(open(os.path.join(DIR, 'frames.json')))
# The first frame or two can predate the title card; start at 0.4 s.
frames = [f for f in frames if f['t'] >= frames[0]['t'] + 0.4] or frames
t0 = frames[0]['t']
dur = frames[-1]['t'] - t0
seq = os.path.join(DIR, 'seq')
shutil.rmtree(seq, ignore_errors=True)
os.makedirs(seq)

# Hold the end card for a few seconds.
n = math.ceil((dur + 2.5) * FPS) + 1
j = 0
for k in range(n):
    t = t0 + k / FPS
    while j + 1 < len(frames) and frames[j + 1]['t'] <= t:
        j += 1
    os.link(os.path.join(DIR, 'frames', frames[j]['name']), os.path.join(seq, f's{k:05d}.jpg'))
print(f'{n} frames, {n / FPS:.1f}s')

# Contact sheet: one thumbnail every 1.5 s.
step = int(FPS * 1.5)
thumbs = [Image.open(os.path.join(seq, f's{k:05d}.jpg')).resize((480, 270)) for k in range(0, n, step)]
cols = 5
rows = math.ceil(len(thumbs) / cols)
sheet = Image.new('RGB', (cols * 480, rows * 270))
for i, im in enumerate(thumbs):
    sheet.paste(im, ((i % cols) * 480, (i // cols) * 270))
sheet.save(os.path.join(DIR, 'sheet.jpg'), quality=85)

if '--encode' in sys.argv:
    # The mpv that ships with Tenvy can encode (libx264); see scripts/fetch-mpv.ps1.
    mpv = os.path.join(HERE, '..', '..', 'src-tauri', 'resources', 'mpv', 'mpv.exe')
    out = os.path.join(DIR, 'tenvy-demo.mp4')
    subprocess.run([
        mpv, f'mf://{seq}/*.jpg', f'--mf-fps={FPS}', '--no-config', '--no-audio',
        f'--o={out}', '--of=mp4', '--ovc=libx264',
        '--vf=scale=1920:1080,format=yuv420p',
        '--ovcopts=crf=20,preset=slow,profile=high,movflags=+faststart',
    ], check=True)
    print(out, os.path.getsize(out) // 1024, 'KB')
