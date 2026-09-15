from app.hardware.live import CHANNELS, MockLiveFrames, parse_command


def test_mock_live_frame_matches_firmware_contract():
    generator = MockLiveFrames(seed=7)

    first = generator.next()
    second = generator.next()

    assert first["mode"] == "live"
    assert first["seq"] == 1
    assert second["seq"] == 2
    assert first["t_ms"] >= 0
    assert set(first["raw"]) == set(CHANNELS)
    assert all(isinstance(value, int) and value >= 0 for value in first["raw"].values())


def test_parse_command_accepts_only_live_controls():
    assert parse_command('{"cmd":"live_start"}') == "live_start"
    assert parse_command('{"cmd":"live_stop"}') == "live_stop"
    assert parse_command('{"cmd":"erase"}') is None
    assert parse_command("not json") is None
