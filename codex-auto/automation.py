import re
import time
import xml.etree.ElementTree as ET

import uiautomator2 as u2

GOPAY_PKG = "com.gojek.gopay"

_GOPAY_NOTIFICATION_RE = re.compile(r'\b(?:gopay|gojek)\b', re.IGNORECASE)
_GOPAY_CODE_RE = re.compile(
    r'(?<!\d)(\d(?:[\s-]?\d){5})(?!\d)\s+is\s+your\s+verification\s+code\b',
    re.IGNORECASE,
)


def _wait_xpath(d, xpath, timeout=20):
    el = d.xpath(xpath)
    if not el.wait(timeout=timeout):
        raise RuntimeError(f"xpath not found: {xpath}")
    return el


def _click(d, xpath, timeout=20):
    _wait_xpath(d, xpath, timeout).click()


def _normalize_code(value: str) -> str:
    return re.sub(r'[\s-]', '', value or '')


def _extract_gopay_code(text: str) -> str:
    for match in _GOPAY_CODE_RE.finditer(text or ''):
        code = _normalize_code(match.group(1))
        if len(code) == 6:
            return code
    return ''


def _node_texts(node) -> list[str]:
    texts: list[str] = []
    for item in node.iter("node"):
        for attr in ("text", "content-desc"):
            value = (item.attrib.get(attr, "") or "").strip()
            if value:
                texts.append(value)
    return texts


def _collect_gopay_code_candidates(root) -> list[tuple[int, str, str]]:
    candidates: list[tuple[int, str, str]] = []
    for index, node in enumerate(root.iter("node")):
        texts = _node_texts(node)
        if not texts:
            continue
        combined = " ".join(texts)
        if not _GOPAY_NOTIFICATION_RE.search(combined):
            continue
        code = _extract_gopay_code(combined)
        if code:
            candidates.append((index, code, combined[:240]))
    return candidates


def get_latest_whatsapp_code(d, log) -> str:
    """打开通知栏，只读取 GoPay 通知中 “xxxxxx is your verification code” 格式的 6 位 OTP。"""
    log("打开通知栏")
    d.open_notification()
    time.sleep(2)
    try:
        xml = d.dump_hierarchy()
        root = ET.fromstring(xml)

        candidates = _collect_gopay_code_candidates(root)

        if not candidates:
            raise RuntimeError("未在通知栏找到 GoPay 的 6 位 verification code 验证码")

        candidates.sort(key=lambda x: x[0])
        code = candidates[0][1]
        log(f"提取到验证码: {code} (源: {candidates[0][2]})")
        return code
    finally:
        d.press("back")


def clear_all_notifications(d, log) -> bool:
    """打开通知栏并点击 “Clear all”（含中文/资源 ID 兜底），清空所有通知。"""
    log("打开通知栏")
    d.open_notification()
    time.sleep(2)
    candidates = [
        '//*[@resource-id="com.android.systemui:id/clear_all"]',
        '//*[@resource-id="com.android.systemui:id/dismiss_text"]',
        '//*[@resource-id="com.android.systemui:id/dismiss_view"]',
        '//*[contains(@content-desc, "Clear all")]',
        '//*[contains(@content-desc, "清除")]',
        '//*[@text="Clear all"]',
        '//*[@text="清除全部"]',
        '//*[@text="全部清除"]',
        '//*[@text="清除"]',
    ]
    try:
        for xp in candidates:
            el = d.xpath(xp)
            if el.exists:
                log(f"清除全部通知: {xp}")
                el.click()
                time.sleep(1)
                return True
        log("未找到清除按钮，可能本来就没有可清除的通知")
        return False
    finally:
        d.press("back")


def gopay_get_balance(d, log) -> str:
    """冷启动 GoPay，定位 content-desc='Rp' 的 View，读它后面紧邻的那个 View 的文本作为余额。"""
    log("冷启动 GoPay 应用")
    d.app_start(GOPAY_PKG, stop=True)
    time.sleep(5)

    xpath = '//android.view.View[@content-desc="Rp"]/following::android.view.View[1]'
    el = _wait_xpath(d, xpath, timeout=30)
    info = el.info or {}
    value = (info.get("text") or info.get("contentDescription") or "").strip()
    if not value:
        raise RuntimeError(f"{xpath} 上未读到任何文本")
    log(f"余额: Rp {value}")
    return value


def gopay_unlink(d, log):
    """打开 GoPay，执行 Profile -> Account & app settings -> Linked apps -> Unlink 流程。"""
    log("启动 GoPay 应用")
    d.app_start(GOPAY_PKG, stop=True)
    time.sleep(5)

    log("点击 Profile")
    _click(d, '//*[@content-desc="Profile"]', timeout=30)
    time.sleep(2)

    log("点击 Account & app settings")
    _click(
        d,
        '//*[@content-desc="Account & app settings\nControl your app preferences, data, linked apps and more."]',
        timeout=20,
    )
    time.sleep(2)

    log("点击 Linked apps")
    _click(
        d,
        '//*[@content-desc="Linked apps\nList of apps that you link to GoPay"]',
        timeout=20,
    )
    time.sleep(2)

    log("等待并点击 Unlink")
    _click(d, '//*[@content-desc="Unlink"]', timeout=60)
    time.sleep(2)

    log("点击确认按钮")
    _click(d, '//android.widget.Button', timeout=20)
    time.sleep(3)
    log("Unlink 完成")
