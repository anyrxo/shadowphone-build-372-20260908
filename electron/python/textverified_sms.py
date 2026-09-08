import asyncio
import re
import time
from datetime import datetime
from urllib.parse import urlencode, urlparse

BASE = "https://www.textverified.com"
API = "/api/pub/v2"


class TextVerifiedSms:
    def __init__(self, api_key, api_username):
        self.api_key = str(api_key or "").strip()
        self.api_username = str(api_username or "").strip()
        self.token = None
        self.configured = bool(self.api_key and self.api_username)

    async def _request(self, method, route, body=None):
        import httpx

        if not self.configured:
            raise ValueError("TextVerified credentials are not configured")
        if not route.startswith(API + "/") or "://" in route:
            raise ValueError("Invalid TextVerified request path")
        async with httpx.AsyncClient(timeout=15.0) as client:
            if not self.token:
                response = await client.post(BASE + API + "/auth", headers={
                    "X-API-KEY": self.api_key, "X-API-USERNAME": self.api_username,
                })
                response.raise_for_status()
                self.token = response.json().get("token")
                if not isinstance(self.token, str) or not self.token:
                    raise ValueError("TextVerified authentication failed")
            response = await client.request(
                method, BASE + route, headers={"Authorization": "Bearer " + self.token},
                **({"json": body} if body is not None else {}),
            )
            response.raise_for_status()
            return response.json() if response.content else {}

    async def buy(self, max_price, on_order=None, before_purchase=None):
        try:
            cap = float(max_price)
        except (TypeError, ValueError):
            cap = 0
        if not self.configured or not (0.01 <= cap <= 100) or abs(cap * 100 - round(cap * 100)) > 1e-8:
            return {"ok": False, "error": "Set TextVerified credentials and a valid maximum SMS price."}
        purchase_sent = False
        try:
            catalog = await self._request("GET", API + "/services?numberType=mobile&reservationType=verification")
            service = next((row for row in catalog if str(row.get("serviceName", "")).lower() == "instagram"
                            and row.get("capability") in {"sms", "smsAndVoiceCombo"}), None)
            if not service:
                return {"ok": False, "error": "Instagram SMS verification is unavailable from TextVerified."}
            quote = await self._request("POST", API + "/pricing/verifications", {
                "serviceName": service["serviceName"], "areaCode": False, "carrier": False,
                "numberType": "mobile", "capability": "sms",
            })
            price = float(quote["price"])
            if not (0 < price <= cap):
                return {"ok": False, "error": "TextVerified price exceeds the selected SMS limit."}
            if before_purchase:
                await before_purchase()
            purchase_sent = True
            action = await self._request("POST", API + "/verifications", {
                "serviceName": service["serviceName"], "capability": "sms", "maxPrice": cap,
            })
            parsed = urlparse(str(action.get("href", "")))
            if parsed.netloc and (parsed.scheme != "https" or parsed.netloc != "www.textverified.com"):
                raise ValueError("Untrusted verification response")
            match = re.fullmatch(r"/api/pub/v2/verifications/([A-Za-z0-9_-]{1,256})", parsed.path)
            if not match or parsed.query or parsed.fragment or str(action.get("method", "")).upper() != "GET":
                raise ValueError("Untrackable verification response")
            order_id = match.group(1)
            if on_order:
                await on_order(order_id)
            details = await self._request("GET", parsed.path)
            if details.get("id") != order_id or str(details.get("serviceName", "")).lower() != "instagram":
                raise ValueError("Verification identity mismatch")
            digits = re.sub(r"\D", "", str(details.get("number", "")))
            if len(digits) == 10:
                digits = "1" + digits
            if len(digits) != 11 or not digits.startswith("1"):
                raise ValueError("Invalid US verification number")
            return {"ok": True, "phone": "+" + digits, "order_id": order_id}
        except Exception:
            if purchase_sent:
                return {
                    "ok": False, "code": "ACCOUNT_CREATION_OUTCOME_UNCERTAIN",
                    "error": "TextVerified purchase outcome is uncertain. Reconcile the original order before retrying.",
                    "manual_action_required": True, "reconciliation_required": True,
                }
            return {"ok": False, "error": "TextVerified pre-purchase verification failed. No number was purchased."}

    async def poll(self, order_id, timeout_s=15):
        try:
            return await asyncio.wait_for(self._poll(order_id, timeout_s), timeout=timeout_s)
        except asyncio.TimeoutError:
            return {"ok": False}

    async def _poll(self, order_id, timeout_s):
        if not re.fullmatch(r"[A-Za-z0-9_-]{1,256}", str(order_id)):
            return {"ok": False}
        try:
            details = await self._request("GET", API + "/verifications/" + order_id)
            created = datetime.fromisoformat(details["createdAt"].replace("Z", "+00:00"))
            if created.tzinfo is None:
                return {"ok": False}
            number = str(details["number"])
            def normalize(value):
                digits = re.sub(r"\D", "", str(value))
                return digits[1:] if len(digits) == 11 and digits.startswith("1") else digits
            deadline = time.monotonic() + timeout_s
            while time.monotonic() < deadline:
                messages = await self._request("GET", API + "/sms?" + urlencode({"to": number, "reservationType": "verification"}))
                for message in messages.get("data", []):
                    try:
                        received = datetime.fromisoformat(str(message.get("createdAt", "")).replace("Z", "+00:00"))
                    except ValueError:
                        continue
                    code = str(message.get("parsedCode") or "")
                    if (received.tzinfo is not None and received >= created
                            and normalize(message.get("to")) == normalize(number)
                            and re.fullmatch(r"\d{4,8}", code)):
                        return {"ok": True, "code": code}
                await asyncio.sleep(min(3, max(0, deadline - time.monotonic())))
        except Exception:
            return {"ok": False}
        return {"ok": False}

    async def cancel(self, order_id):
        if not re.fullmatch(r"[A-Za-z0-9_-]{1,256}", str(order_id)):
            return {"ok": False}
        try:
            await self._request("POST", API + "/verifications/" + order_id + "/cancel")
            details = await self._request("GET", API + "/verifications/" + order_id)
            confirmed = details.get("state") in {"verificationCanceled", "verificationRefunded"}
            return {"ok": confirmed, "refund_requested": confirmed}
        except Exception:
            return {"ok": False}
