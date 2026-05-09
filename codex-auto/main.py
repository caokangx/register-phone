import os
import threading
import traceback
from datetime import datetime

import uiautomator2 as u2
from fastapi import FastAPI, HTTPException

from automation import (
    clear_all_notifications,
    get_latest_whatsapp_code,
    gopay_get_balance,
    gopay_unlink,
)

DEVICE_SERIAL = os.environ.get("UIA2_SERIAL", "")

app = FastAPI(title="gopay-auto")

_device_lock = threading.Lock()


def _connect():
    return u2.connect(DEVICE_SERIAL) if DEVICE_SERIAL else u2.connect()


def _log(msg: str):
    print(f"[{datetime.now().isoformat(timespec='seconds')}] {msg}", flush=True)


@app.get("/whatsapp/code")
def whatsapp_code():
    with _device_lock:
        try:
            d = _connect()
            _log(f"connected: {d.serial}")
            code = get_latest_whatsapp_code(d, _log)
            return {"code": code}
        except Exception as e:
            raise HTTPException(500, f"{e}\n{traceback.format_exc()}")


@app.post("/notifications/clear")
def clear_notifications():
    with _device_lock:
        try:
            d = _connect()
            _log(f"connected: {d.serial}")
            cleared = clear_all_notifications(d, _log)
            return {"ok": True, "cleared": cleared}
        except Exception as e:
            raise HTTPException(500, f"{e}\n{traceback.format_exc()}")


@app.get("/balance")
def balance():
    with _device_lock:
        try:
            d = _connect()
            _log(f"connected: {d.serial}")
            value = gopay_get_balance(d, _log)
            return {"balance": value}
        except Exception as e:
            raise HTTPException(500, f"{e}\n{traceback.format_exc()}")


@app.post("/unlink")
def unlink():
    with _device_lock:
        try:
            d = _connect()
            _log(f"connected: {d.serial}")
            gopay_unlink(d, _log)
            return {"ok": True}
        except Exception as e:
            raise HTTPException(500, f"{e}\n{traceback.format_exc()}")


@app.get("/health")
def health():
    return {"ok": True}


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=int(os.environ.get("PORT", "8000")))
