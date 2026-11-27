from pydantic_settings import BaseSettings


class Settings(BaseSettings):
    """Backend settings, read from SHIFTBOOTH_* environment variables or .env."""

    MODELS_DIR: str = "models"
    # Loopback by default: the API has no login and can load model files, so
    # exposing it to the network (0.0.0.0) has to be a deliberate choice.
    HOST: str = "127.0.0.1"
    PORT: int = 8000
    SAMPLE_RATE: int = 40000
    CHUNK_SIZE: int = 4096
    # Extra web origins allowed to call the API, as a JSON list, e.g.
    # '["https://voice.example.com"]'. Pages served by this server or from this
    # machine never need listing. '["*"]' turns the cross-site check off.
    CORS_ORIGINS: list[str] = []
    LOG_LEVEL: str = "info"
    HUBERT_PATH: str = "models/assets/hubert_base.pt"
    RMVPE_ROOT: str = "models/assets/rmvpe"
    RVC_STREAM_CONTEXT_SECONDS: float = 0.08
    # 0 = skip FAISS index in realtime (huge indexes make CPU RVC unusable).
    RVC_INDEX_RATE: float = 0.0
    RVC_FILTER_RADIUS: int = 3
    RVC_RMS_MIX_RATE: float = 0.25
    RVC_PROTECT: float = 0.33
    PRESETS_PATH: str = "data/presets.json"
    SLOTS_PATH: str = "data/slots.json"
    PROFILES_PATH: str = "data/profiles.json"
    MAX_CONVERT_SECONDS: int = 600
    DEFAULT_LATENCY_MODE: str = "balanced"

    model_config = {
        "env_prefix": "SHIFTBOOTH_",
        "env_file": ".env",
        "extra": "ignore",
    }


settings = Settings()
