import pytest

import capture_policy
from capture_policy import (
    LISTED_APP_TITLE,
    MAX_PROCESS_NAME_LENGTH,
    UNLISTED_TITLE,
    evidence_allowed,
    is_domain_pattern,
    normalize_process_name,
    normalize_title,
)


@pytest.fixture(autouse=True)
def rules():
    capture_policy.set_rules(
        [
            {"executable_name": "chrome.exe", "title_contains": "salesforce.com", "classification": "productive", "priority": 5},
            {"executable_name": "", "title_contains": ".zendesk.com", "classification": "productive", "priority": 1},
            {"executable_name": "excel.exe", "title_contains": "", "classification": "productive", "priority": 1},
            {"executable_name": "", "title_contains": "YouTube", "classification": "non_productive", "priority": 1},
            {"executable_name": "slack.exe", "title_contains": "", "classification": "neutral", "priority": 1},
        ]
    )
    yield
    capture_policy.set_rules([])


@pytest.mark.parametrize(
    "pattern,expected",
    [
        ("salesforce.com", True),
        (".salesforce.com", True),
        ("app.salesforce.com", True),
        ("Salesforce", False),
        ("Google Docs", False),
        ("report 1.2", False),
        ("", False),
    ],
)
def test_is_domain_pattern(pattern, expected):
    assert is_domain_pattern(pattern) is expected


@pytest.mark.parametrize(
    "title",
    [
        "Home | salesforce.com - Google Chrome",
        "Salesforce.com - Google Chrome",
        "app.salesforce.com/lightning - Google Chrome",
        "https://salesforce.com/login - Google Chrome",
        "Ir a salesforce.com.",
    ],
)
def test_domain_pattern_matches_whole_domain_or_subdomain(title):
    assert normalize_title("chrome.exe", title) == ("salesforce.com", True)


@pytest.mark.parametrize(
    "title",
    [
        "evil-salesforce.com - Google Chrome",
        "notsalesforce.com - Google Chrome",
        "salesforce.com.evil.net - Google Chrome",
        "salesforce.community - Google Chrome",
        "salesforce - Google Chrome",
    ],
)
def test_domain_pattern_rejects_lookalikes(title):
    assert normalize_title("chrome.exe", title) == (UNLISTED_TITLE, False)
    assert evidence_allowed("chrome.exe", title) is False


def test_leading_dot_domain_pattern_matches_subdomains_and_root():
    assert normalize_title("msedge.exe", "Ticket 12 - acme.zendesk.com")[1] is True
    assert normalize_title("msedge.exe", "zendesk.com pricing")[1] is True
    assert normalize_title("msedge.exe", "fakezendesk.com")[1] is False


def test_non_domain_pattern_is_case_insensitive_substring():
    identifier, listed = normalize_title("chrome.exe", "Cat videos - youtube - Chrome")
    assert (identifier, listed) == ("YouTube", True)
    assert evidence_allowed("chrome.exe", "Cat videos - youtube - Chrome") is False


def test_executable_only_rule_uses_listed_identifier():
    assert normalize_title("EXCEL.EXE", "Nomina secreta.xlsx - Excel") == (LISTED_APP_TITLE, True)
    assert evidence_allowed("excel.exe", "Nomina.xlsx - Excel") is True


def test_neutral_app_is_listed_but_not_captured():
    assert normalize_title("slack.exe", "general")[1] is True
    assert evidence_allowed("slack.exe", "general") is False


def test_unlisted_app_is_never_captured_and_title_hidden():
    identifier, listed = normalize_title("notepad.exe", "diario personal.txt")
    assert identifier == UNLISTED_TITLE
    assert listed is False
    assert evidence_allowed("notepad.exe", "diario personal.txt") is False


def test_higher_rank_title_rule_wins():
    capture_policy.set_rules(
        [
            {"executable_name": "", "title_contains": "Portal", "classification": "neutral", "priority": 1},
            {"executable_name": "", "title_contains": "Portal RRHH", "classification": "productive", "priority": 1, "scope_score": 10},
        ]
    )
    assert normalize_title("chrome.exe", "Portal RRHH - Chrome") == ("Portal RRHH", True)
    assert evidence_allowed("chrome.exe", "Portal RRHH - Chrome") is True


def test_process_name_truncated_to_80_chars():
    long_name = "x" * 200 + ".exe"
    assert len(normalize_process_name(long_name)) == MAX_PROCESS_NAME_LENGTH
    assert normalize_process_name("  chrome.exe ") == "chrome.exe"
