#!/bin/bash
# setup-whisper.sh — optional: voice input transcribed on this server with Whisper (faster-whisper).
# Makes whisper/.venv, installs faster-whisper (+ CUDA 12 cuBLAS/cuDNN wheels when there is an NVIDIA GPU),
# installs the beast-whisper systemd --user unit. Not enabled at boot: the dashboard starts it when the mic is
# pressed and it exits after a minute idle. Without it the mic falls back to the browser's speech recognition.
set -e
cd "$(dirname "$0")/.."; REPO=$(pwd)
PY=python3; command -v uv >/dev/null && USE_UV=1
if [ -n "$USE_UV" ]; then uv venv -q --python 3.12 whisper/.venv; PIP="uv pip install -q --python whisper/.venv/bin/python"
else $PY -m venv whisper/.venv; PIP="whisper/.venv/bin/pip install -q"; fi
$PIP faster-whisper
if command -v nvidia-smi >/dev/null && nvidia-smi -L >/dev/null 2>&1; then echo "NVIDIA GPU found: installing CUDA 12 libraries"; $PIP nvidia-cublas-cu12 'nvidia-cudnn-cu12==9.*'; else echo "no NVIDIA GPU: Whisper runs on the CPU (set WHISPER_MODEL='small' in whisper/whisper.env for speed)"; fi
[ -f whisper/whisper.env ] || cp whisper/whisper.env.example whisper/whisper.env
mkdir -p ~/.config/systemd/user
sed -e "s#__REPO__#$REPO#g" beast-whisper.service > ~/.config/systemd/user/beast-whisper.service
systemctl --user daemon-reload
echo "done — press the mic in a chat; the first start downloads the model (~1.6 GB for large-v3-turbo)."
