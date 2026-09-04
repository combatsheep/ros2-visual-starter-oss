from ros2_visual_backend.secure_rosbridge import origin_is_allowed


def test_origin_allowlist_is_exact_and_fail_closed() -> None:
    assert origin_is_allowed("http://127.0.0.1:27182")
    assert origin_is_allowed("http://localhost:27182")
    assert not origin_is_allowed(None)
    assert not origin_is_allowed("")
    assert not origin_is_allowed("http://example.invalid")
    assert not origin_is_allowed("https://127.0.0.1:27182")
    assert not origin_is_allowed("http://127.0.0.1:9090")
