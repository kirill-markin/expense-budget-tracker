#!/usr/bin/env python3

import json
import pathlib
import sys
from typing import TypeAlias

JsonPrimitive: TypeAlias = None | bool | int | float | str
JsonValue: TypeAlias = JsonPrimitive | list["JsonValue"] | dict[str, "JsonValue"]


def load_json_object(path: pathlib.Path) -> dict[str, JsonValue]:
    value: JsonValue = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(value, dict):
        raise ValueError(f"{path} must contain a JSON object")
    return value


def is_expected_subset(actual: JsonValue, expected: JsonValue) -> bool:
    if isinstance(expected, dict):
        if not isinstance(actual, dict):
            return False
        return all(
            key in actual and is_expected_subset(actual[key], expected_value)
            for key, expected_value in expected.items()
        )
    return actual == expected


def main() -> None:
    if len(sys.argv) != 2:
        raise SystemExit(f"Usage: {sys.argv[0]} <expected-rule.json>")

    expected_path = pathlib.Path(sys.argv[1])
    expected_rule = load_json_object(expected_path)
    response: JsonValue = json.load(sys.stdin)
    if not isinstance(response, dict) or response.get("success") is not True:
        raise ValueError("Cloudflare rate-limit response is not successful")

    result = response.get("result")
    if not isinstance(result, dict):
        raise ValueError("Cloudflare rate-limit response has no ruleset object")
    rules = result.get("rules")
    if not isinstance(rules, list) or any(not isinstance(rule, dict) for rule in rules):
        raise ValueError("Cloudflare rate-limit ruleset has no valid rules array")

    description = expected_rule.get("description")
    expression = expected_rule.get("expression")
    if not isinstance(description, str) or not description:
        raise ValueError("Repository MCP rate-limit contract has no description")
    if not isinstance(expression, str) or not expression:
        raise ValueError("Repository MCP rate-limit contract has no expression")
    candidates = [
        rule
        for rule in rules
        if isinstance(rule, dict)
        and (
            rule.get("description") == description
            or rule.get("expression") == expression
        )
    ]
    if len(candidates) != 1:
        raise ValueError(
            "Cloudflare must contain exactly one managed MCP rate-limit rule; "
            f"found {len(candidates)}"
        )
    if not is_expected_subset(candidates[0], expected_rule):
        raise ValueError(
            "Cloudflare MCP rate-limit rule differs from the repository contract: "
            f"{json.dumps(candidates[0], sort_keys=True)}"
        )

    ratelimit = expected_rule.get("ratelimit")
    if not isinstance(ratelimit, dict):
        raise ValueError("Repository MCP rate-limit contract has no ratelimit object")
    requests_per_period = ratelimit.get("requests_per_period")
    period = ratelimit.get("period")
    mitigation_timeout = ratelimit.get("mitigation_timeout")
    for field_name, value in {
        "requests_per_period": requests_per_period,
        "period": period,
        "mitigation_timeout": mitigation_timeout,
    }.items():
        if type(value) is not int or value <= 0:
            raise ValueError(
                f"Repository MCP rate-limit contract field {field_name} must be a positive integer"
            )
    print(
        "Verified MCP rate limit: "
        f"{requests_per_period} requests per {period} seconds "
        f"per IP, block for {mitigation_timeout} seconds."
    )


if __name__ == "__main__":
    try:
        main()
    except (OSError, UnicodeDecodeError, json.JSONDecodeError, ValueError) as error:
        print(f"ERROR: {error}", file=sys.stderr)
        raise SystemExit(1) from error
