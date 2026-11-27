# Voice models: where to get them and how to load them

You do not need a model to use BadloVoice. The built-in engine handles pitch, formant and effects on its own. Models are for turning your voice into a specific trained voice, and they need the Python backend.

A **model** is a trained voice file you load on the **Models** tab.

| File | Role |
|------|------|
| `.pth` / `.pt` | RVC v1/v2 voice model. Needs PyTorch, HuBERT and fairseq. |
| `.onnx` | ONNX export of a voice model. Needs onnxruntime. |
| `.index` | Optional FAISS index that goes with a `.pth`. Improves similarity and reduces artifacts. |

## What you need

| Piece | Where it goes | Notes |
|-------|---------------|-------|
| Backend dependencies | your virtualenv | `pip install -r backend/requirements.txt` |
| HuBERT | `models/assets/hubert_base.pt` | About 190 MB. Required for `.pth` models. |
| RMVPE | `models/assets/rmvpe/rmvpe.pt` | About 180 MB. Only for the RMVPE pitch method. |
| RVC package | your virtualenv | See the command below. |

`.onnx` models load with just the backend dependencies. `.pth` models also need fairseq and the RVC package:

```powershell
.\.venv\Scripts\Activate.ps1
pip install "fairseq @ git+https://github.com/Tps-F/fairseq.git@main"
pip install --no-deps git+https://github.com/RVC-Project/Retrieval-based-Voice-Conversion
```

On Windows, fairseq may need the Visual Studio C++ Build Tools.

HuBERT and RMVPE are published at https://huggingface.co/lj1995/VoiceConversionWebUI

## Where to find voice models

Search for **RVC v2** models (`.pth`) shared by their creators:

1. **Hugging Face**: search [`RVC`](https://huggingface.co/models?search=RVC) or [`rvc-models`](https://huggingface.co/models?search=rvc).
2. **Voice model communities**: people post `.pth` and `.index` packs. Check the license and whose voice it is.
3. **Train your own** with the [RVC WebUI](https://github.com/RVC-Project/Retrieval-based-Voice-Conversion-WebUI) on your GPU, from your own recordings.

Tips:

- Prefer RVC v2 with its matching `.index`.
- Only use voices you have the right to use: your own, or models shared with permission.
- A `.pth` is usually 50 to 150 MB.

### Example packs

These are creator-shared voices, not celebrity clones. They are not included in this repository.

| Source | Voices |
|--------|--------|
| [fahmifauzi/rvc-malaysian-voices](https://huggingface.co/fahmifauzi/rvc-malaysian-voices) | Two female and two male voices |
| [PhoenixStormJr/RVC-V2-default-voice](https://huggingface.co/PhoenixStormJr/RVC-V2-default-voice) | A creator's test voice |

## How to load a model

1. Start the backend and open the app.
2. Open the **Models** tab.
3. Drop in the `.pth` or `.onnx` file, plus the `.index` if you have one. The index must have the same name as the model (`voice.pth` and `voice.index`); rename downloaded files like `added_IVF256_Flat_nprobe_1_voice_v2.index`, or the index is ignored.
4. Press **Activate**.
5. Go back to **Studio** and press **Start voice**. Use headphones.

You can also copy files into `models/` and refresh the list.

While a model is active the server produces the voice. The formant slider is left to the model. Deactivate it to return to the built-in engine.

The pitch slider sets the model's transpose: about +12 to take a male voice into a female model, −12 the other way.
