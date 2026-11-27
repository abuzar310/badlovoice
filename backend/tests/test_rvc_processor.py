"""RVC processor: streaming window logic around the inference pipeline.

torch and the RVC runtime are not part of the light install, so the model and
pipeline loaders are replaced by a stand-in that "converts" audio by returning
it unchanged. Everything else (context handling, resampling, cropping, locks)
is the real code.
"""

import threading
import time

import numpy as np
import pytest

from backend.config import settings
from backend.services.audio_processor import resample
from backend.services.rvc_processor import RvcProcessor, _RuntimeConfig

from .conftest import rms, tone

SR = 48000


class PassthroughPipeline:
    """Honours the contract of rvc's ``Pipeline.pipeline``: 16 kHz float audio
    in, int16 out at ``resample_sr`` (or the model rate), in whole 10 ms frames
    aligned to the start of the input."""

    def __init__(self, seconds_per_call: float = 0.0) -> None:
        self.seconds_per_call = seconds_per_call
        self.inputs: list[np.ndarray] = []
        self.index_paths: list = []
        self.running = threading.Event()

    def pipeline(
        self, model, net_g, sid, audio, input_audio_path, times, f0_up_key, f0_method,
        file_index, index_rate, if_f0, filter_radius, tgt_sr, resample_sr, rms_mix_rate,
        version, protect, f0_file=None,
    ):  # fmt: skip
        self.inputs.append(np.array(audio))
        self.index_paths.append(file_index)
        self.running.set()
        time.sleep(self.seconds_per_call)
        out_sr = resample_sr if resample_sr >= 16000 and resample_sr != tgt_sr else tgt_sr
        whole_frames = audio[: len(audio) // 160 * 160]
        converted = resample(whole_frames.astype(np.float32), 16000, out_sr)
        return (np.clip(converted, -1.0, 1.0) * 32767).astype(np.int16)


@pytest.fixture
def make_processor(tmp_path, monkeypatch):
    model = tmp_path / "voice.pth"
    model.write_bytes(b"stand-in checkpoint")
    hubert = tmp_path / "hubert_base.pt"
    hubert.write_bytes(b"")
    monkeypatch.setattr(settings, "HUBERT_PATH", str(hubert))
    monkeypatch.setattr(settings, "RMVPE_ROOT", str(tmp_path / "rmvpe"))
    monkeypatch.setattr(
        RvcProcessor,
        "_select_runtime_config",
        staticmethod(lambda: _RuntimeConfig("cpu", False, 1, 6, 38, 41)),
    )
    monkeypatch.setattr(
        RvcProcessor, "_load_hubert_model", lambda self: setattr(self, "_hubert_model", object())
    )

    def make(pipeline) -> RvcProcessor:
        def load_model(self):
            self._net_g = object()
            self._pipeline = pipeline
            self._target_sample_rate = 40000

        monkeypatch.setattr(RvcProcessor, "_load_model", load_model)
        return RvcProcessor(str(model))

    return make


def stream(processor, signal, chunk):
    return [
        processor.process(signal[i : i + chunk], sample_rate=SR, stream_id="live")
        for i in range(0, len(signal), chunk)
    ]


@pytest.mark.parametrize("chunk", [4096, 8192], ids=["balanced-85ms", "quality-171ms"])
def test_chunks_longer_than_the_context_window_are_converted_in_full(make_processor, chunk):
    processor = make_processor(PassthroughPipeline())
    x = tone(seconds=6 * chunk / SR, freq=220, amp=0.5)

    outputs = stream(processor, x, chunk)

    for out in outputs[1:]:  # the very first chunk may start with a short lead-in
        assert out.shape == (chunk,)
        assert rms(out[:256]) > 0.1, "the chunk starts with a gap of silence"
        assert rms(out) == pytest.approx(rms(x), rel=0.1)


def test_whole_file_passed_as_one_chunk_is_converted_from_the_start(make_processor):
    processor = make_processor(PassthroughPipeline())
    x = tone(seconds=2.0, freq=220, amp=0.5)

    y = processor.process(x, sample_rate=SR, stream_id="file")

    assert y.shape == x.shape
    assert rms(y[SR // 10 : SR]) == pytest.approx(rms(x), rel=0.1)


def test_short_chunks_are_converted_with_earlier_audio_as_context(make_processor):
    pipeline = PassthroughPipeline()
    processor = make_processor(pipeline)
    chunk = 1024  # 21 ms: "ultra" latency mode
    x = tone(seconds=12 * chunk / SR, freq=220, amp=0.5)

    outputs = stream(processor, x, chunk)

    chunk_16k = round(chunk * 16000 / SR)
    assert len(pipeline.inputs[-1]) > chunk_16k  # the model saw more than the bare chunk
    for out in outputs[4:]:
        assert out.shape == (chunk,)
        assert rms(out) == pytest.approx(rms(x), rel=0.15)


def test_streams_do_not_share_context(make_processor):
    pipeline = PassthroughPipeline()
    processor = make_processor(pipeline)
    loud = tone(seconds=1024 / SR, amp=0.5)
    silent = np.zeros(1024, dtype=np.float32)

    processor.process(loud, sample_rate=SR, stream_id="a")
    processor.process(silent, sample_rate=SR, stream_id="b")

    assert np.max(np.abs(pipeline.inputs[-1])) == 0.0


def test_release_stream_drops_its_context(make_processor):
    pipeline = PassthroughPipeline()
    processor = make_processor(pipeline)
    loud = tone(seconds=1024 / SR, amp=0.5)
    silent = np.zeros(1024, dtype=np.float32)

    processor.process(loud, sample_rate=SR, stream_id="a")
    processor.release_stream("a")
    processor.process(silent, sample_rate=SR, stream_id="a")

    assert np.max(np.abs(pipeline.inputs[-1])) == 0.0


def test_release_stream_does_not_wait_for_a_running_inference(make_processor):
    pipeline = PassthroughPipeline(seconds_per_call=1.0)
    processor = make_processor(pipeline)
    x = tone(seconds=4096 / SR)
    inference = threading.Thread(
        target=processor.process, args=(x,), kwargs={"sample_rate": SR, "stream_id": "busy"}
    )
    inference.start()
    assert pipeline.running.wait(timeout=5)

    started = time.perf_counter()
    processor.release_stream("gone")  # what a WebSocket disconnect does, on the event loop
    waited = time.perf_counter() - started
    inference.join()

    assert waited < 0.2


def test_model_without_an_index_file_passes_an_empty_index_path(make_processor):
    # rvc's pipeline takes "no index" as an empty string: the upstream WebUI
    # code tests `file_index != "" and os.path.exists(file_index)`, and
    # os.path.exists(None) raises TypeError.
    pipeline = PassthroughPipeline()
    processor = make_processor(pipeline)

    processor.process(tone(seconds=0.1), sample_rate=SR, stream_id="x")

    assert pipeline.index_paths == [""]


def test_unloaded_processor_refuses_to_process(make_processor):
    processor = make_processor(PassthroughPipeline())
    processor.unload()

    with pytest.raises(RuntimeError, match="not loaded"):
        processor.process(tone(seconds=0.1), sample_rate=SR, stream_id="x")


def test_missing_hubert_error_names_the_real_setting(tmp_path, monkeypatch):
    model = tmp_path / "voice.pth"
    model.write_bytes(b"stand-in checkpoint")
    monkeypatch.setattr(settings, "HUBERT_PATH", str(tmp_path / "missing.pt"))

    with pytest.raises(FileNotFoundError, match="SHIFTBOOTH_HUBERT_PATH"):
        RvcProcessor(str(model))
