"""Exercise each remaining FadiEffect through a real native export and report whether it
bakes. Run with the bridge .venv while the Bridge is up on :8765."""
import glob, json, time, urllib.request

TOKEN = "fadicut-dev"
BASE = "http://127.0.0.1:8765"


def find_clip():
    for pat in (
        "/Volumes/Seagate Portable Drive/assets/*.mp4",
        "/Volumes/Seagate Portable Drive/FADISHOOTS/**/*.mp4",
    ):
        hits = glob.glob(pat, recursive=True)
        if hits:
            return hits[0]
    return None


def find_images(n=4):
    imgs = []
    for pat in ("/Volumes/Seagate Portable Drive/assets/*.png",
                "/Volumes/Seagate Portable Drive/assets/*.jpg",
                "/Users/adamghaleb/Pictures/adam fadi/**/*.png"):
        imgs += glob.glob(pat, recursive=True)
        if len(imgs) >= n:
            break
    return imgs[:n]


def submit(name, edl):
    body = json.dumps({"edl": edl, "out_path": f"/tmp/{name}.mp4", "smoke_frames": 36}).encode()
    req = urllib.request.Request(f"{BASE}/render", data=body,
        headers={"Content-Type": "application/json", "Authorization": f"Bearer {TOKEN}"})
    try:
        return json.load(urllib.request.urlopen(req))["id"]
    except urllib.error.HTTPError as e:
        return f"HTTP{e.code}:{e.read().decode()[:200]}"


def poll(jid, secs=180):
    if not jid.startswith("job_"):
        return {"status": "submit_failed", "error": jid}
    for _ in range(secs // 3):
        s = json.load(urllib.request.urlopen(urllib.request.Request(
            f"{BASE}/jobs/{jid}", headers={"Authorization": f"Bearer {TOKEN}"})))
        if s.get("status") in ("succeeded", "failed"):
            return s
        time.sleep(3)
    return {"status": "timeout"}


def main():
    clip = find_clip()
    imgs = find_images(4)
    print("clip:", clip)
    print("images:", len(imgs))

    def main_clip(effects, dur=2.0):
        return {"id": "m1", "type": "video", "media_id": "m1", "name": "c",
                "start_sec": 0, "duration_sec": dur, "params": {"src_path": clip},
                "effects": effects}

    def edl(name, elements, tracks_extra=None, song_id=None):
        tracks = [{"id": "m", "name": "main", "type": "video", "role": "main", "elements": elements}]
        if tracks_extra:
            tracks += tracks_extra
        e = {"schema_version": "1.1.0", "project_id": name, "name": name,
             "render": {"width": 1080, "height": 1920, "fps": 24}, "tracks": tracks}
        if song_id:
            e["song_id"] = song_id
        return e

    cases = {
        "ramp": edl("ramp", [main_clip([{"type": "ramp", "engine": "speedramp", "mode": "whoosh", "use_rife": False}])]),
        "overlay": edl("overlay", [main_clip([{"type": "overlay", "engine": "fadishoot_overlays", "category": "color_bars", "beat_sync": False, "coverage": "partial"}])]),
        "blob_track": edl("blob", [main_clip([{"type": "blob_track", "engine": "fadi_blob_track", "shape": "square", "color": "#00CFFF", "follow": "center", "beat_react": False}])]),
        "lyric_overlay": edl("lyricov", [main_clip([])],
            tracks_extra=[{"id": "o", "name": "ly", "type": "text", "role": "overlay", "elements": [
                {"id": "e2", "type": "text", "name": "ly", "start_sec": 0, "duration_sec": 2.0, "text": "me and u",
                 "effects": [{"type": "lyric", "engine": "meandu", "fill_mode": "tri_zone", "line_range": [0, 0]}]}]}],
            song_id="me-and-u"),
    }
    if len(imgs) >= 4:
        cases["morph"] = edl("morph", [main_clip([{"type": "morph", "engine": "morphloop",
            "target_media_ids": imgs[:4], "beat_cut": False}])], song_id="me-and-u")

    results = {}
    for name, e in cases.items():
        jid = submit(name, e)
        r = poll(jid)
        baked = (r.get("result") or {}).get("baked") if r.get("result") else None
        results[name] = {"status": r.get("status"), "baked": baked, "error": str(r.get("error"))[:200]}
        print(f"{name:14} -> {r.get('status'):10} baked={baked} err={str(r.get('error'))[:160]}")

    print("\nSUMMARY:", json.dumps(results))


if __name__ == "__main__":
    main()
