# Module: ig_login
# Logs into Instagram with username and password.
import asyncio
import xml.etree.ElementTree as ET
from lib.ws_modules_shared import Element, WSDeviceAdapter
from lib.persistent_log import ModuleLogger

_LOG = ModuleLogger("ig_login")


def _screen_nodes(xml):
    nodes = []
    for node in ET.fromstring(xml).iter("node"):
        attrs = node.attrib
        if attrs.get("package", "com.instagram.android") != "com.instagram.android":
            continue
        bounds = Element(bounds=attrs.get("bounds"))
        if attrs.get("enabled") != "false" and bounds.x2 > bounds.x1 and bounds.y2 > bounds.y1:
            nodes.append(attrs)
    return nodes


def _credential_field(nodes, field):
    matches = []
    for node in nodes:
        if node.get("class") != "android.widget.EditText":
            continue
        secure = node.get("password") == "true"
        labels = " ".join(node.get(attr, "") for attr in ("text", "hint", "content-desc")).lower()
        resource_id = node.get("resource-id", "").rsplit("/", 1)[-1].lower()
        if field == "password":
            matched = secure
        else:
            matched = not secure and (
                resource_id in {"login_username", "username", "username_input", "login_email"}
                or any(label in labels for label in ("username", "email", "mobile number", "phone number"))
            )
        if matched:
            matches.append(node)
    return matches[0] if len(matches) == 1 else None


def _login_button(nodes):
    matches = [node for node in nodes if node.get("clickable") == "true" and any(
        node.get(attr, "").strip().lower() in {"log in", "log into existing account"}
        for attr in ("text", "content-desc")
    )]
    return matches[0] if len(matches) == 1 else None


async def run(device: WSDeviceAdapter, config: dict) -> dict:
    """Log into Instagram via WebSocket"""
    username = config.get("username") or config.get("email")
    password = config.get("password")
    if not isinstance(username, str) or not username.strip() or not isinstance(password, str) or not password:
        return {"success": False, "error": "Username and password required"}
    username = username.strip()
    previous_capture = device.set_action_screen_capture(False)
    try:
        await device.launch_app("com.instagram.android")
        await asyncio.sleep(3)
        nodes = _screen_nodes(await device.refresh_screen(force=True))
        # Only open a login screen when no editable form is already visible.
        if not any(node.get("class") == "android.widget.EditText" for node in nodes):
            login_btn = _login_button(nodes)
            if login_btn:
                await device.click(Element(bounds=login_btn["bounds"]))
                await asyncio.sleep(1)
                nodes = _screen_nodes(await device.refresh_screen(force=True))
        if any(_credential_field(nodes, field) is None for field in ("username", "password")):
            return {"success": False, "error": "Could not identify both Instagram login fields"}

        for field, value in (("username", username), ("password", password)):
            # The keyboard can move the form; never reuse the previous field's coordinates.
            nodes = _screen_nodes(await device.refresh_screen(force=True))
            control = _credential_field(nodes, field)
            if control is None:
                return {"success": False, "error": f"Could not identify Instagram {field} field"}
            await device.click(Element(bounds=control["bounds"]))
            await asyncio.sleep(0.3)
            control = _credential_field(_screen_nodes(await device.refresh_screen(force=True)), field)
            if control is None or control.get("focused") != "true":
                return {"success": False, "error": f"Could not focus Instagram {field} field"}
            await device.clear()
            control = _credential_field(_screen_nodes(await device.refresh_screen(force=True)), field)
            if control is None or control.get("focused") != "true" or control.get("text", ""):
                return {"success": False, "error": f"Could not clear Instagram {field} field"}
            await device.send_keys(value)

        submit_btn = _login_button(_screen_nodes(await device.refresh_screen(force=True)))
        if submit_btn is None:
            return {"success": False, "error": "Could not identify Instagram Log in button"}
        await device.click(Element(bounds=submit_btn["bounds"]))
        await asyncio.sleep(10)
        await device.refresh_screen(force=True)
        home_tab = await device.find_element_by_content_desc("Home")
        if home_tab:
            return {"success": True, "username": username}

        return {"success": False, "error": "Login requires attention on the device; authentication could not be verified"}

    except Exception as error:
        # Executor exceptions can contain input_text parameters. Never echo them.
        err_msg = f"Instagram login command failed ({type(error).__name__})"
        try:
            await _LOG.error(device, err_msg)
        except Exception:
            pass
        return {"success": False, "error": err_msg}
    finally:
        device.set_action_screen_capture(previous_capture)
