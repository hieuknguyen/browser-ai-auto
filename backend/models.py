from typing import Annotated, Any, Literal, Union
from pydantic import BaseModel, ConfigDict, Field, StringConstraints, TypeAdapter, model_validator


class StrictModel(BaseModel):
    model_config = ConfigDict(extra="forbid", populate_by_name=True, allow_inf_nan=False)


class Target(StrictModel):
    model_config = ConfigDict(extra="ignore", populate_by_name=True, allow_inf_nan=False)

    strategy: Literal["role", "label", "testId", "text", "css", "coordinates"]
    role: str | None = Field(default=None, max_length=100)
    name: str | None = Field(default=None, max_length=2000)
    label: str | None = Field(default=None, max_length=2000)
    testId: str | None = Field(default=None, max_length=2000)
    text: str | None = Field(default=None, max_length=2000)
    selector: str | None = Field(default=None, max_length=2000)
    frames: list[str] | None = Field(default=None, max_length=8)
    exact: bool | None = None
    nth: int | None = Field(default=None, ge=0, le=10000)
    x: float | None = Field(default=None, ge=0, le=100000)
    y: float | None = Field(default=None, ge=0, le=100000)

    @model_validator(mode="before")
    @classmethod
    def normalize_target_data(cls, data: Any) -> Any:
        if not isinstance(data, dict):
            return data
        d = dict(data)
        if not d.get("strategy"):
            if d.get("role"):
                d["strategy"] = "role"
            elif d.get("selector") or d.get("css"):
                d["strategy"] = "css"
            elif d.get("label"):
                d["strategy"] = "label"
            elif d.get("testId"):
                d["strategy"] = "testId"
            elif d.get("text"):
                d["strategy"] = "text"
            elif d.get("x") is not None and d.get("y") is not None:
                d["strategy"] = "coordinates"
            elif d.get("name"):
                d["strategy"] = "role"
                d["role"] = "button"
        if d.get("strategy") == "role" and not d.get("role") and d.get("name"):
            d["role"] = "button"
        if d.get("strategy") == "css" and "css" in d and not d.get("selector"):
            d["selector"] = d.get("css")
        if d.get("strategy") == "text" and "name" in d and not d.get("text"):
            d["text"] = d.get("name")
        return d

    @model_validator(mode="after")
    def required_fields(self):
        required = {"role": ["role"], "label": ["label"], "testId": ["testId"], "text": ["text"], "css": ["selector"], "coordinates": ["x", "y"]}[self.strategy]
        if any(getattr(self, field) is None or getattr(self, field) == "" for field in required):
            raise ValueError(f"Missing target fields for {self.strategy}")
        if self.strategy == "coordinates" and self.frames:
            raise ValueError("Coordinates must be in the main browser viewport")
        return self


class StepBase(StrictModel):
    model_config = ConfigDict(extra="ignore", populate_by_name=True, allow_inf_nan=False)
    timeoutMs: int = Field(default=10000, ge=50, le=120000)


class Goto(StepBase):
    action: Literal["goto"]
    path: str = Field(min_length=1, max_length=4000)


class Click(StepBase):
    action: Literal["click", "doubleClick", "rightClick", "move", "hover"]
    target: Target
    button: Literal["left", "right", "middle"] = "left"
    popup: str | None = Field(default=None, max_length=100)


class Fill(StepBase):
    action: Literal["fill", "select"]
    target: Target
    value: str = Field(max_length=100000)


class Press(StepBase):
    action: Literal["press"]
    key: str = Field(min_length=1, max_length=100)
    target: Target | None = None


class TypeText(StepBase):
    action: Literal["type"]
    value: str = Field(max_length=100000)


class Button(StepBase):
    action: Literal["down", "up"]
    button: Literal["left", "right", "middle"] = "left"


class Wheel(StepBase):
    action: Literal["wheel"]
    deltaX: float = Field(default=0, ge=-100000, le=100000)
    deltaY: float = Field(ge=-100000, le=100000)


class Drag(StepBase):
    action: Literal["drag"]
    from_: Target = Field(alias="from")
    to: Target
    steps: int = Field(default=20, ge=2, le=120)


class Wait(StepBase):
    action: Literal["wait", "expectVisible"]
    target: Target
    state: Literal["visible", "hidden", "attached", "detached"] = "visible"


class ExpectText(StepBase):
    action: Literal["expectText"]
    target: Target
    text: str = Field(max_length=10000)
    exact: bool = False


class Screenshot(StepBase):
    action: Literal["screenshot"]
    name: str = Field(default="screenshot", pattern=r"^[a-zA-Z0-9_-]{1,80}$")


class NewPage(StepBase):
    action: Literal["newPage"]
    name: str = Field(min_length=1, max_length=100)
    path: str | None = Field(default=None, max_length=4000)


class SwitchPage(StepBase):
    action: Literal["switchPage"]
    page: str = Field(min_length=1, max_length=100)


Step = Annotated[Union[Goto, Click, Fill, Press, TypeText, Button, Wheel, Drag, Wait, ExpectText, Screenshot, NewPage, SwitchPage], Field(discriminator="action")]
step_adapter = TypeAdapter(Step)


def validate_step(value: dict) -> dict:
    return step_adapter.validate_python(value).model_dump(by_alias=True, exclude_none=True)


class Viewport(StrictModel):
    width: int = Field(ge=320, le=3840)
    height: int = Field(ge=240, le=2160)


class TestDefinition(StrictModel):
    id: str = Field(pattern=r"^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,99}$")
    name: str = Field(default="Untitled test", min_length=1, max_length=200)
    environment: str = Field(default="local", pattern=r"^[a-zA-Z0-9_-]{1,50}$")
    tags: list[str] = Field(default_factory=list, max_length=30)
    safetyLevel: Literal["read-only", "safe-write", "destructive"] = "read-only"
    productionAllowed: bool = False
    testAccount: str | None = Field(default=None, max_length=320)
    timeoutMs: int = Field(default=120000, ge=1000, le=1200000)
    viewport: Viewport | None = None
    steps: list[Step] = Field(min_length=1, max_length=500)


def validate_test(value: dict) -> dict:
    return TestDefinition.model_validate(value).model_dump(by_alias=True, exclude_none=True)


class RunRequest(StrictModel):
    test: TestDefinition
    mode: Literal["fast", "watch"] = "watch"


class SessionRequest(StrictModel):
    environment: str = "local"
    mode: Literal["fast", "watch"] = "watch"
    url: str | None = Field(default=None, max_length=4000)


class AISettingsRequest(StrictModel):
    apiKey: str | None = Field(default=None, min_length=1, max_length=500, repr=False)
    model: str | None = Field(default=None, pattern=r"^[a-zA-Z0-9._/-]{1,100}$")
    apiUrl: str | None = Field(default=None, max_length=1000)


class AITaskRequest(StrictModel):
    instruction: str = Field(min_length=3, max_length=12000)
    startUrl: str = Field(default="", max_length=4000)
    allowedDomains: list[str] = Field(default_factory=list, max_length=30)
    maxSteps: int = Field(default=20, ge=1, le=50)
    sessionId: str | None = None
    pageId: str | None = Field(default=None, max_length=100)

    @model_validator(mode="after")
    def page_requires_session(self):
        if self.pageId and not self.sessionId:
            raise ValueError("A page must belong to a selected browser session")
        return self


class AIWorkflowRequest(StrictModel):
    name: Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=200)] = "Danh sách công việc"
    instructions: list[Annotated[str, StringConstraints(strip_whitespace=True, min_length=3, max_length=12000)]] = Field(min_length=1, max_length=50)
    startUrl: str = Field(default="", max_length=4000)
    sessionId: str | None = None
    allowedDomains: list[str] = Field(default_factory=list, max_length=30)
    maxSteps: int = Field(default=20, ge=1, le=50)
    continueOnError: bool = False
