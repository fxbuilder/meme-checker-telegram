#!/usr/bin/env python
"""
scripts/discover_group.py
Find the chat id of a group the bot is genuinely a MEMBER of.

Fixes two problems found in the first run:
  1. getUpdates replays its backlog, so a stale update was reported repeatedly.
     This version drains the backlog with an explicit offset first.
  2. my_chat_member updates also arrive when the bot is REMOVED, so a kicked
     group looked like a find. This version only accepts a chat where the bot's
     own status is member/administrator, verified via getChatMember.

Usage:
  python scripts/discover_group.py <token> [out.json] [max_seconds]
"""
import json
import sys
import time
import urllib.error
import urllib.request

TOKEN = sys.argv[1]
OUT = sys.argv[2] if len(sys.argv) > 2 else "group-discovery.json"
MAX_SECONDS = int(sys.argv[3]) if len(sys.argv) > 3 else 600


def call(method, timeout=35):
    req = urllib.request.Request(f"https://api.telegram.org/bot{TOKEN}/{method}")
    try:
        return json.load(urllib.request.urlopen(req, timeout=timeout))
    except urllib.error.HTTPError as e:
        try:
            return json.loads(e.read().decode())
        except Exception:
            return {"ok": False, "description": f"http {e.code}"}
    except Exception as e:
        return {"ok": False, "description": str(e)}


def bot_id():
    r = call("getMe")
    return r["result"]["id"] if r.get("ok") else None


def bot_status_in(chat_id, me):
    r = call(f"getChatMember?chat_id={chat_id}&user_id={me}")
    if not r.get("ok"):
        return None
    return r["result"].get("status")


def main():
    me = bot_id()
    if not me:
        print("BOT_ID_FAILED", flush=True)
        return

    # ---- 1. Drain the backlog so history is not re-reported ------------------
    offset = None
    drained = 0
    while True:
        url = "getUpdates?limit=100&timeout=0"
        if offset is not None:
            url += f"&offset={offset}"
        r = call(url)
        ups = r.get("result", [])
        if not ups:
            break
        for up in ups:
            offset = up["update_id"] + 1
        drained += len(ups)
        if len(ups) < 100:
            break
    print(f"drained {drained} historical update(s)", flush=True)

    # ---- 2. Wait for something new ------------------------------------------
    started = time.time()
    found = None
    while time.time() - started < MAX_SECONDS:
        url = "getUpdates?limit=100&timeout=25"
        if offset is not None:
            url += f"&offset={offset}"
        r = call(url, timeout=45)
        if not r.get("ok"):
            print("poll error:", r.get("description"), flush=True)
            time.sleep(5)
            continue

        for up in r.get("result", []):
            offset = up["update_id"] + 1
            for kind, m in up.items():
                if kind == "update_id" or not isinstance(m, dict):
                    continue
                chat = m.get("chat")
                if not chat or chat.get("type") not in ("group", "supergroup"):
                    continue
                cid = chat.get("id")
                status = bot_status_in(cid, me)
                if status not in ("member", "administrator", "creator"):
                    print(f"  skip {cid} ({chat.get('title')}): bot status={status}", flush=True)
                    continue
                found = {
                    "chat_id": cid,
                    "type": chat.get("type"),
                    "title": chat.get("title"),
                    "update_kind": kind,
                    "bot_status": status,
                    "sender_id": (m.get("from") or {}).get("id"),
                    "sender_username": (m.get("from") or {}).get("username"),
                }
                break
            if found:
                break
        if found:
            break

    if found:
        with open(OUT, "w", encoding="utf-8") as f:
            json.dump(found, f, indent=2)
        print("FOUND " + json.dumps(found), flush=True)
    else:
        print("NO_GROUP_UPDATE", flush=True)


if __name__ == "__main__":
    main()
