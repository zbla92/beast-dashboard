#!/bin/bash
# Start the Whisper service: settings from whisper.env (if present), CUDA 12 libraries from the venv's
# nvidia-* wheels (cuBLAS + cuDNN) on the loader path when they are installed.
cd "$(dirname "$0")"
[ -x .venv/bin/python ] || { echo "whisper: no .venv — run bin/setup-whisper.sh first" >&2; exit 1; }
if [ -f whisper.env ]; then set -a; . ./whisper.env; set +a; fi
SP=$(.venv/bin/python -c 'import site; print(site.getsitepackages()[0])')
for d in "$SP/nvidia/cublas/lib" "$SP/nvidia/cudnn/lib"; do [ -d "$d" ] && export LD_LIBRARY_PATH="$d:${LD_LIBRARY_PATH}"; done
exec .venv/bin/python server.py
