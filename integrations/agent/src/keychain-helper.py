"""Small macOS Keychain bridge. Secrets cross only private stdin/stdout pipes.

No third-party packages, shell, environment credentials, or token arguments.
The login Keychain owns encryption and access prompts; this is not a separate
security identity from other code running as the same OS user.
"""
import ctypes as c
import json
import re
import sys


def main():
    raw = sys.stdin.buffer.read(4097)
    if len(raw) > 4096:
        raise ValueError()
    request = json.loads(raw)
    action = request.get("action")
    service = request.get("service", "")
    credential = request.get("credentialId", "")
    if action not in {"get", "set", "remove", "clear"}:
        raise ValueError()
    if not re.fullmatch(r"org\.happylatent\.huggingface\.[0-9a-f]{64}", service):
        raise ValueError()
    if action != "clear" and not re.fullmatch(r"[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}", credential):
        raise ValueError()
    token = request.get("token", "")
    if action == "set" and not re.fullmatch(r"hf_[A-Za-z0-9]{10,256}", token):
        raise ValueError()
    if sys.platform != "darwin":
        raise ValueError()

    cf = c.CDLL("/System/Library/Frameworks/CoreFoundation.framework/CoreFoundation")
    sec = c.CDLL("/System/Library/Frameworks/Security.framework/Security")
    ptr = c.c_void_p
    cf.CFStringCreateWithCString.argtypes = [ptr, c.c_char_p, c.c_uint32]
    cf.CFStringCreateWithCString.restype = ptr
    cf.CFDictionaryCreateMutable.argtypes = [ptr, c.c_long, ptr, ptr]
    cf.CFDictionaryCreateMutable.restype = ptr
    cf.CFDictionarySetValue.argtypes = [ptr, ptr, ptr]
    cf.CFRelease.argtypes = [ptr]
    cf.CFDataCreate.argtypes = [ptr, c.c_char_p, c.c_long]
    cf.CFDataCreate.restype = ptr
    cf.CFDataGetLength.argtypes = [ptr]
    cf.CFDataGetLength.restype = c.c_long
    cf.CFDataGetBytePtr.argtypes = [ptr]
    cf.CFDataGetBytePtr.restype = ptr
    cf.CFGetTypeID.argtypes = [ptr]
    cf.CFGetTypeID.restype = c.c_ulong
    cf.CFDataGetTypeID.restype = c.c_ulong
    sec.SecItemAdd.argtypes = [ptr, ptr]
    sec.SecItemAdd.restype = c.c_int32
    sec.SecItemCopyMatching.argtypes = [ptr, c.POINTER(ptr)]
    sec.SecItemCopyMatching.restype = c.c_int32
    sec.SecItemDelete.argtypes = [ptr]
    sec.SecItemDelete.restype = c.c_int32
    owned = []

    def own(value):
        if not value:
            raise ValueError()
        owned.append(value)
        return value

    def constant(name):
        return ptr.in_dll(sec, name).value

    def string(value):
        return own(cf.CFStringCreateWithCString(None, value.encode("utf-8"), 0x08000100))

    try:
        query = own(cf.CFDictionaryCreateMutable(None, 0,
                    c.addressof(c.c_byte.in_dll(cf, "kCFTypeDictionaryKeyCallBacks")),
                    c.addressof(c.c_byte.in_dll(cf, "kCFTypeDictionaryValueCallBacks"))))

        def put(key, value):
            cf.CFDictionarySetValue(query, constant(key), value)

        put("kSecClass", constant("kSecClassGenericPassword"))
        put("kSecAttrService", string(service))
        if action != "clear":
            put("kSecAttrAccount", string(credential))
        if action == "set":
            encoded = token.encode("utf-8")
            put("kSecValueData", own(cf.CFDataCreate(None, encoded, len(encoded))))
            put("kSecAttrLabel", string("Happy Latent Hugging Face model access"))
            status = sec.SecItemAdd(query, None)
            if status != 0:
                raise ValueError()
            result = {"ok": True}
        elif action == "get":
            put("kSecReturnData", ptr.in_dll(cf, "kCFBooleanTrue").value)
            put("kSecMatchLimit", constant("kSecMatchLimitOne"))
            found = ptr()
            status = sec.SecItemCopyMatching(query, c.byref(found))
            if status == -25300:  # errSecItemNotFound
                result = {"token": None}
            elif status == 0 and found.value:
                own(found.value)
                if cf.CFGetTypeID(found) != cf.CFDataGetTypeID():
                    raise ValueError()
                length = cf.CFDataGetLength(found)
                if not 13 <= length <= 259:
                    raise ValueError()
                secret = c.string_at(cf.CFDataGetBytePtr(found), length).decode("utf-8")
                if not re.fullmatch(r"hf_[A-Za-z0-9]{10,256}", secret):
                    raise ValueError()
                result = {"token": secret}
            else:
                raise ValueError()
        else:
            status = sec.SecItemDelete(query)
            if status not in (0, -25300):
                raise ValueError()
            result = {"ok": True}
        sys.stdout.write(json.dumps(result))
    finally:
        for value in reversed(owned):
            cf.CFRelease(value)


if __name__ == "__main__":
    try:
        main()
    except Exception:
        # Never echo request fields or native framework details.
        sys.stderr.write("OS credential store operation failed.\n")
        sys.exit(2)
