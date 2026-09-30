import os
from dataclasses import dataclass, field
from pathlib import Path
from dotenv import load_dotenv

ROOT = Path(__file__).resolve().parent.parent


def environments_from_env(port: int) -> list[dict]:
    local = os.getenv("ENGINE_LOCAL_URL", f"http://localhost:{port}")
    from urllib.parse import urlsplit
    extra = [value.strip() for value in os.getenv("ENGINE_ALLOWED_DOMAINS", "*").split(",") if value.strip()]
    environments = []
    for name, url, production in [
        ("local", local, False), ("development", os.getenv("ENGINE_DEVELOPMENT_URL", local), False),
        ("staging", os.getenv("ENGINE_STAGING_URL", local), False),
        ("production", os.getenv("ENGINE_PRODUCTION_URL", "https://app.example.com"), True),
    ]:
        environment = {"name": name, "baseURL": url, "production": production,
                       "allowedDomains": list(dict.fromkeys([urlsplit(url).hostname, *(['localhost', '127.0.0.1', *extra] if name in ('local', 'development') else extra if not production else [])]))}
        if production:
            environment["policy"] = {"enabled": os.getenv("ENGINE_PRODUCTION_ENABLED", "false").lower() == "true",
                "maxConcurrency": 1, "requireTestAccount": True, "testAccount": os.getenv("ENGINE_TEST_ACCOUNT"),
                "blockedActions": [], "blockedMethods": ["DELETE", "POST", "PUT", "PATCH"],
                "blockedPathPatterns": [r"/(?:delete|payments?|checkout|billing|send-email|send-sms)(?:/|$)"],
                "requestsPerMinute": 120}
        environments.append(environment)
    return environments


@dataclass
class Settings:
    port: int = 3210
    headless: bool = False
    browser_channel: str = "chrome"
    executable_path: str | None = None
    concurrency: int = 4
    artifact_root: Path = field(default_factory=lambda: ROOT / "artifacts")
    gemini_api_key: str = field(default="", repr=False)
    gemini_model: str = "gemini-2.5-flash"
    ai_base_url: str = ""
    environments: list[dict] = field(default_factory=list)

    def __post_init__(self):
        if not 1 <= self.concurrency <= 32:
            raise ValueError("ENGINE_CONCURRENCY must be between 1 and 32")
        if not self.environments:
            self.environments = environments_from_env(self.port)

    @classmethod
    def from_env(cls):
        load_dotenv(ROOT / ".env")
        return cls(port=int(os.getenv("PORT", "3210")), headless=os.getenv("BROWSER_HEADLESS", "false").lower() == "true",
            browser_channel=os.getenv("BROWSER_CHANNEL", "chrome"), executable_path=os.getenv("BROWSER_EXECUTABLE_PATH") or None,
            concurrency=int(os.getenv("ENGINE_CONCURRENCY", "4")), gemini_api_key=os.getenv("GEMINI_API_KEY", ""),
            gemini_model=os.getenv("GEMINI_MODEL", "gemini-2.5-flash"),
            ai_base_url=os.getenv("AI_BASE_URL", os.getenv("GEMINI_API_URL", "")))
