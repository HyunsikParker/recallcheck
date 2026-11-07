"""Assemble the RecallCheck demo video: phone screenshots from capture.py on a 1920x1080 stage with a
caption, title cards, and local Qwen3-TTS narration (demo/audio/*.wav).

Usage: python3 build_video.py
Writes demo/build/*.mp4 parts and demo/recallcheck-demo.mp4.
"""
import json, subprocess, wave
from pathlib import Path
import numpy as np
from PIL import Image, ImageDraw, ImageFont

D = Path(__file__).resolve().parent
FR, AU, OUT = D / "build" / "frames", D / "audio", D / "build"
W, H = 1920, 1080
PAPER, INK, INK2, HIT = (238, 242, 245), (0, 0, 0), (59, 72, 83), (164, 22, 26)
PX, PY, PW, PH = 330, 40, 450, 1000  # phone screenshot box on the stage
LEAD, TAIL, END_HOLD = 0.5, 0.9, 1.0
SCENES = [  # scene, audio, heading, caption
    ("s1_barcode", "s1", "Barcode", "An exact match against barcodes printed in FDA and CPSC recall records."),
    ("s2_photo", "s2", "Photo", "DINOv2 compares your photo with 9,845 CPSC recall photos, in the browser. The photo is not uploaded."),
    ("s3_label", "s3", "Label", "tesseract.js reads the model number on the phone and checks it against recall notices."),
    ("s4_name", "s4", "Name", "Brands and model numbers. Model numbers match without their dashes."),
    ("s5_about", "s5", "Measured", "Tested on recall photos left out of the index, and on copies altered to look like phone photos."),
]
SF = "/System/Library/Fonts/SFNS.ttf"


def font(size, weight="Regular"):
    f = ImageFont.truetype(SF, size)
    f.set_variation_by_name(weight)
    return f


def wrap(d, text, f, width):
    lines, cur = [], ""
    for w in text.split():
        t = (cur + " " + w).strip()
        if d.textlength(t, font=f) <= width:
            cur = t
        else:
            lines.append(cur)
            cur = w
    return lines + [cur]


def wav_seconds(p):
    with wave.open(str(p)) as w:
        return w.getnframes() / w.getframerate()


def stage(path, heading, caption):
    im = Image.new("RGB", (W, H), PAPER)
    d = ImageDraw.Draw(im)
    d.rounded_rectangle([PX - 16, PY - 16, PX + PW + 16, PY + PH + 16], radius=44, fill=INK)
    x = 930
    d.text((x, 300), "RecallCheck", font=font(34, "Semibold"), fill=INK2)
    d.text((x - 4, 350), heading, font=font(104, "Heavy"), fill=INK)
    d.rectangle([x, 492, x + 120, 500], fill=INK)
    y = 540
    for ln in wrap(d, caption, font(42), 860):
        d.text((x, y), ln, font=font(42), fill=INK2)
        y += 60
    im.save(path)


def card(path, title, lines, foot):
    im = Image.new("RGB", (W, H), PAPER)
    d = ImageDraw.Draw(im)
    x = 170
    d.text((x - 6, 300), title, font=font(124, "Heavy"), fill=INK)
    d.rectangle([x, 462, x + 160, 472], fill=INK)
    y = 520
    for ln in lines:
        d.text((x, y), ln, font=font(50), fill=INK)
        y += 74
    fy = H - 120 - 44 * (len(foot) - 1)
    for ln in foot:
        d.text((x, fy), ln, font=font(30), fill=INK2)
        fy += 44
    im.save(path)


def frames_of(scene, log):
    rows = sorted((r for r in log if r[0] == scene), key=lambda r: r[1])
    return [r[1] for r in rows], [r[2] / 1000 for r in rows]


def motion(scene, idx):
    prev, out = None, []
    for i in idx:
        a = np.asarray(Image.open(FR / scene / f"f{i:04d}.jpg").convert("L").resize((206, 457)), dtype=np.float32)
        out.append(0.0 if prev is None else float(np.mean(np.abs(a - prev))))
        prev = a
    return out


def timeline(scene, log, need):
    """Frame durations: real time, static stretches capped, then stretched or trimmed toward the narration."""
    idx, t = frames_of(scene, log)
    mv = motion(scene, idx)
    raw = [max(0.02, t[k + 1] - t[k]) for k in range(len(t) - 1)] + [END_HOLD]
    moving = [k + 1 < len(mv) and mv[k + 1] > 0.4 for k in range(len(raw))]

    def capped(cap):
        out, run, ends = [], 0.0, []
        for k, dur in enumerate(raw):
            if moving[k]:
                if run > 0:
                    ends.append(k - 1)
                out.append(dur); run = 0.0
            else:
                keep = max(0.0, min(dur, cap - run)); run += dur
                out.append(keep)
        ends.append(len(raw) - 1)
        return out, ends

    cap = 3.0
    out, ends = capped(cap)
    while sum(out) > need + 1.0 and cap > 0.8:
        cap -= 0.1
        out, ends = capped(cap)
    if need > sum(out):  # spread the extra over the pauses so the narration stays near its picture
        extra = (need - sum(out)) / len(ends)
        for k in ends:
            out[k] += extra
    return idx, out


def encode_scene(scene, log, audio, heading, caption, out):
    narr = wav_seconds(audio)
    idx, durs = timeline(scene, log, narr + LEAD + TAIL)
    lst = OUT / f"{scene}.ffconcat"
    lines = ["ffconcat version 1.0"]
    for i, dur in zip(idx, durs):
        if dur > 0.0005:
            lines += [f"file '{(FR / scene / f'f{i:04d}.jpg').as_posix()}'", f"duration {dur:.4f}"]
    lines.append(f"file '{(FR / scene / f'f{idx[-1]:04d}.jpg').as_posix()}'")
    lst.write_text("\n".join(lines) + "\n")
    total = sum(d for d in durs if d > 0.0005)
    bg = OUT / f"{scene}-stage.png"
    stage(bg, heading, caption)
    filt = (f"[0:v]format=rgb24[bg];[1:v]scale={PW}:{PH}:flags=lanczos,format=rgb24[p];"
            f"[bg][p]overlay={PX}:{PY}:shortest=1,fps=30,scale=out_range=tv,format=yuv420p,setparams=range=tv[v];"
            f"[2:a]adelay={int(LEAD * 1000)},apad,atrim=0:{total:.3f},aresample=48000[a]")
    cmd = ["ffmpeg", "-y", "-loglevel", "error", "-loop", "1", "-i", str(bg), "-f", "concat", "-safe", "0", "-i", str(lst),
           "-i", str(audio), "-filter_complex", filt, "-map", "[v]", "-map", "[a]", "-color_range", "tv",
           "-c:v", "libx264", "-preset", "medium", "-crf", "18", "-c:a", "aac", "-b:a", "160k", "-ac", "1",
           "-t", f"{total:.3f}", str(out)]
    subprocess.run(cmd, check=True)
    return round(total, 2), round(narr, 2)


def encode_card(png, audio, out):
    dur = wav_seconds(audio) + LEAD + TAIL
    filt = (f"[0:v]fps=30,scale=out_range=tv,format=yuv420p,setparams=range=tv,fade=t=in:st=0:d=0.4[v];"
            f"[1:a]adelay={int(LEAD * 1000)},apad,atrim=0:{dur:.3f},aresample=48000[a]")
    cmd = ["ffmpeg", "-y", "-loglevel", "error", "-loop", "1", "-i", str(png), "-i", str(audio), "-filter_complex", filt,
           "-map", "[v]", "-map", "[a]", "-color_range", "tv", "-c:v", "libx264", "-crf", "18",
           "-c:a", "aac", "-b:a", "160k", "-ac", "1", "-t", f"{dur:.3f}", str(out)]
    subprocess.run(cmd, check=True)
    return round(dur, 2)


def probe(p):
    r = subprocess.run(["ffprobe", "-v", "error", "-select_streams", "v:0", "-show_entries",
                        "stream=pix_fmt,color_range,width,height,r_frame_rate", "-of", "csv=p=0", str(p)],
                       capture_output=True, text=True, check=True)
    return r.stdout.strip()


def main():
    log = json.loads((FR / "log.json").read_text())
    card(OUT / "intro.png", "RecallCheck",
         ["Is something in your home under a US safety recall?",
          "Check by barcode, photo or name. Photos stay on your phone."],
         ["Recall data: U.S. FDA (openFDA food enforcement reports) and U.S. CPSC (Recalls API).",
          "A student project, not affiliated with FDA or CPSC."])
    card(OUT / "outro.png", "RecallCheck",
         ["A static web page: no backend, no paid service.",
          "Barcodes, lots and remedies come from the agency records.",
          "The models only rank and read photos. Always read the official notice."],
         ["Kettle photo: Rafa, public domain, Wikimedia Commons (maker's mark blurred).",
          "Glue gun label: cropped from a CPSC recall notice photo. Image model: DINOv2-small (Meta, Apache-2.0)."])
    parts, report = [], {}
    report["intro"] = encode_card(OUT / "intro.png", AU / "intro.wav", OUT / "00_intro.mp4")
    parts.append(OUT / "00_intro.mp4")
    for n, (scene, au, heading, caption) in enumerate(SCENES, 1):
        out = OUT / f"{n:02d}_{scene}.mp4"
        report[scene] = encode_scene(scene, log, AU / f"{au}.wav", heading, caption, out)
        parts.append(out)
    report["outro"] = encode_card(OUT / "outro.png", AU / "outro.wav", OUT / "99_outro.mp4")
    parts.append(OUT / "99_outro.mp4")
    report["probe"] = sorted({probe(p) for p in parts})
    cat = OUT / "parts.txt"
    cat.write_text("".join(f"file '{p.as_posix()}'\n" for p in parts))
    joined = OUT / "joined.mp4"
    subprocess.run(["ffmpeg", "-y", "-loglevel", "error", "-f", "concat", "-safe", "0", "-i", str(cat), "-c", "copy", str(joined)], check=True)
    final = D / "recallcheck-demo.mp4"
    subprocess.run(["ffmpeg", "-y", "-loglevel", "error", "-i", str(joined), "-c:v", "copy",
                    "-af", "loudnorm=I=-16:TP=-1.5:LRA=11,aresample=48000", "-c:a", "aac", "-b:a", "160k",
                    "-movflags", "+faststart", str(final)], check=True)
    r = subprocess.run(["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", str(final)],
                       capture_output=True, text=True, check=True)
    report["final_seconds"] = round(float(r.stdout.strip()), 2)
    print(json.dumps(report))


if __name__ == "__main__":
    main()
