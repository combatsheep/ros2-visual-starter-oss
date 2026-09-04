from scripts.pixi_environment import ROS_NETWORK_ENVIRONMENT_NAMES, sanitize_ros_environment


def test_ros_environment_does_not_inherit_external_discovery_settings() -> None:
    hostile = {
        name: f"hostile-{name}"
        for name in ROS_NETWORK_ENVIRONMENT_NAMES
    }
    hostile.update({
        "ROS_DISCOVERY_SERVER": "hostile-discovery-server:11811",
        "CYCLONEDDS_URI": "file:///tmp/example.xml",
        "RMW_IMPLEMENTATION": "rmw_cyclonedds_cpp",
        "UNRELATED_USER_SETTING": "preserved",
    })

    isolated = sanitize_ros_environment(hostile)

    assert isolated["RMW_IMPLEMENTATION"] == "rmw_fastrtps_cpp"
    assert isolated["ROS_AUTOMATIC_DISCOVERY_RANGE"] == "LOCALHOST"
    assert isolated["ROS_LOCALHOST_ONLY"] == "1"
    assert isolated["SKIP_DEFAULT_XML"] == "1"
    assert isolated["FASTDDS_BUILTIN_TRANSPORTS"] == "UDPv4"
    assert isolated["UNRELATED_USER_SETTING"] == "preserved"
    for name in ROS_NETWORK_ENVIRONMENT_NAMES:
        if name == "RMW_IMPLEMENTATION":
            assert isolated[name] == "rmw_fastrtps_cpp"
        elif name == "FASTDDS_BUILTIN_TRANSPORTS":
            assert isolated[name] == "UDPv4"
        else:
            assert name not in isolated
