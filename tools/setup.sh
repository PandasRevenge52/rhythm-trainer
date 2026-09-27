#!/usr/bin/env bash
# One-time setup for the high-quality chart maker. Creates a Python environment outside the
# project (so the multi-GB libraries never end up in git) with:
#   Demucs      - splits a song into drums / bass / vocals / other (uses an NVIDIA GPU if present)
#   Basic Pitch - transcribes the vocal stem into notes
#   librosa     - onsets and beat tracking
set -euo pipefail
ENV="${RT_TOOLS_ENV:-$HOME/.local/share/rhythm-trainer-tools/venv}"
command -v uv >/dev/null || { echo "Needs uv: https://docs.astral.sh/uv/ (curl -LsSf https://astral.sh/uv/install.sh | sh)"; exit 1; }
echo "Creating $ENV (Python 3.10, which Basic Pitch needs)…"
uv venv -q -p 3.10 "$ENV"
export VIRTUAL_ENV="$ENV"
if command -v nvidia-smi >/dev/null; then
  echo "NVIDIA GPU found: installing PyTorch with CUDA…"
  uv pip install -q torch torchaudio --index-url https://download.pytorch.org/whl/cu128
else
  echo "No NVIDIA GPU: installing CPU PyTorch (slower, but works)…"
  uv pip install -q torch torchaudio --index-url https://download.pytorch.org/whl/cpu
fi
uv pip install -q demucs librosa soundfile basic-pitch onnxruntime "setuptools<70"
"$ENV/bin/python" -c "import demucs, librosa, basic_pitch, torch; print('Ready. GPU:', torch.cuda.is_available())"
