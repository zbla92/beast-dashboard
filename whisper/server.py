"""Whisper for Beast Dash: a tiny local HTTP service that keeps faster-whisper loaded on the GPU.

POST /transcribe  (body = the recorded audio: webm / mp4 / m4a / wav — whatever the browser's MediaRecorder made)
  ?lang=en|sr|...  optional; default = auto-detect (limited to WHISPER_LANGS when that is set)
  -> {"text": "...", "lang": "sr", "prob": 0.97, "secs": 12.3, "took": 0.8}
GET /health -> {"ok": true, "model": "..."}

Listens on 127.0.0.1 only; beast-dash proxies /api/transcribe to it.
On demand: beast-dash starts the service when the mic is pressed (the model loads in ~2 s while you talk) and it
exits by itself after IDLE_EXIT seconds without work, so the GPU isn't held.

Configuration: environment, usually from whisper/whisper.env (see whisper.env.example):
  WHISPER_MODEL      large-v3-turbo (default) · small · medium · …
  WHISPER_DEVICE     auto (default: CUDA when there is an NVIDIA GPU, else CPU int8) · cuda · cpu
  WHISPER_LANGS      e.g. "sr,en": auto-detect only picks among these (Croatian / Bosnian / … count as Serbian)
  WHISPER_PROMPT     words / style to nudge spelling (names, jargon)
  WHISPER_FIXES      "regex=>replacement;;regex=>replacement" applied to the text (words it keeps mishearing)
  WHISPER_SR_LATIN   1 (default): Serbian comes out in Latin script, 0: leave Cyrillic
  WHISPER_IDLE_EXIT  seconds without work before the service exits (default 60)
"""
import io, json, os, re, threading, time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from faster_whisper import WhisperModel, decode_audio

MODEL = os.environ.get('WHISPER_MODEL', 'large-v3-turbo')
PORT = int(os.environ.get('WHISPER_PORT', '8790'))
DEVICE = os.environ.get('WHISPER_DEVICE', 'auto')
if DEVICE == 'auto':
    try:
        import ctranslate2; DEVICE = 'cuda' if ctranslate2.get_cuda_device_count() > 0 else 'cpu'
    except Exception: DEVICE = 'cpu'
model = WhisperModel(MODEL, device=DEVICE, compute_type='float16' if DEVICE == 'cuda' else 'int8')
LANGS = [x.strip() for x in os.environ.get('WHISPER_LANGS', '').split(',') if x.strip()]
SR_FAMILY = ('sr', 'hr', 'bs', 'sl', 'mk', 'cnr')
gpu = threading.Lock()   # one transcription at a time; the live previews just queue up
IDLE_EXIT = int(os.environ.get('WHISPER_IDLE_EXIT', '60'))
last_use = time.time()


def reaper():
    while True:
        time.sleep(5)
        if time.time() - last_use > IDLE_EXIT and not gpu.locked():
            print(f'idle for {IDLE_EXIT}s -> exiting (frees the GPU)', flush=True); os._exit(0)


# Serbian: Whisper often writes it in Cyrillic; most people type it in Latin script
CYR = dict(zip('абвгдђежзијклљмнњопрстћуфхцчџшАБВГДЂЕЖЗИЈКЛЉМНЊОПРСТЋУФХЦЧЏШ',
               ['a','b','v','g','d','đ','e','ž','z','i','j','k','l','lj','m','n','nj','o','p','r','s','t','ć','u','f','h','c','č','dž','š',
                'A','B','V','G','D','Đ','E','Ž','Z','I','J','K','L','Lj','M','N','Nj','O','P','R','S','T','Ć','U','F','H','C','Č','Dž','Š']))
SR_LATIN = os.environ.get('WHISPER_SR_LATIN', '1') != '0'
def latin(t): return ''.join(CYR.get(c, c) for c in t)
# words it keeps mishearing -> what was meant
FIX = []
for part in os.environ.get('WHISPER_FIXES', '').split(';;'):
    if '=>' in part:
        rx, to = part.split('=>', 1)
        try: FIX.append((re.compile(rx.strip(), re.I), to.strip()))
        except re.error as e: print(f'WHISPER_FIXES: bad regex {rx!r}: {e}', flush=True)
def fix(t):
    for rx, rep in FIX: t = rx.sub(rep, t)
    return t
PROMPT = os.environ.get('WHISPER_PROMPT', '') or None


class H(BaseHTTPRequestHandler):
    def _json(self, code, obj):
        b = json.dumps(obj).encode()
        self.send_response(code); self.send_header('content-type', 'application/json'); self.send_header('content-length', str(len(b))); self.end_headers(); self.wfile.write(b)

    def do_GET(self):
        if self.path.startswith('/health'): return self._json(200, {'ok': True, 'model': MODEL, 'device': DEVICE, 'langs': LANGS, 'idle': round(time.time() - last_use), 'exitIn': max(0, round(IDLE_EXIT - (time.time() - last_use)))})
        self._json(404, {'error': 'not found'})

    def do_POST(self):
        if not self.path.startswith('/transcribe'): return self._json(404, {'error': 'not found'})
        n = int(self.headers.get('content-length') or 0)
        if not n or n > 60 * 1024 * 1024: return self._json(400, {'error': 'no audio / too big'})
        audio = self.rfile.read(n)
        from urllib.parse import urlparse, parse_qs
        q = parse_qs(urlparse(self.path).query); lang = (q.get('lang') or [None])[0] or None
        prompt = (q.get('prompt') or [None])[0] or PROMPT
        global last_use
        t0 = last_use = time.time()
        try:
            with gpu:
                audio_in = io.BytesIO(audio)
                if not lang and len(LANGS) > 1:
                    # detect only among the configured languages (never a random third one); the Serbian family counts as sr
                    audio_in = decode_audio(io.BytesIO(audio), sampling_rate=16000)
                    _, _, probs = model.detect_language(audio_in, vad_filter=True); p = dict(probs)
                    score = {l: (sum(p.get(k, 0) for k in SR_FAMILY) if l == 'sr' else p.get(l, 0)) for l in LANGS}
                    lang = max(score, key=score.get)
                elif not lang and len(LANGS) == 1: lang = LANGS[0]
                segs, info = model.transcribe(audio_in, language=lang, beam_size=5, vad_filter=True,
                                              condition_on_previous_text=False, initial_prompt=prompt)
                text = ' '.join(s.text.strip() for s in segs).strip()
                if SR_LATIN and (lang or info.language) in SR_FAMILY: text = latin(text)
                text = fix(text)
        except Exception as e:  # undecodable / empty chunk
            return self._json(422, {'error': str(e)[:300]})
        last_use = time.time()
        lag = (q.get('lag') or ['?'])[0]
        print(f'{info.duration:5.1f}s audio · lang {lang or info.language} · took {time.time() - t0:.2f}s · mic lag {lag} ms · {len(audio) // 1024} KB · "{text[:50]}"', flush=True)
        self._json(200, {'text': text, 'lang': info.language, 'prob': round(info.language_probability, 3), 'secs': round(info.duration, 2), 'took': round(time.time() - t0, 2)})

    def log_message(self, *a): pass


if __name__ == '__main__':
    threading.Thread(target=reaper, daemon=True).start()
    print(f'whisper {MODEL} on {DEVICE}, 127.0.0.1:{PORT}' + (f', languages {",".join(LANGS)}' if LANGS else ''), flush=True)
    ThreadingHTTPServer(('127.0.0.1', PORT), H).serve_forever()
