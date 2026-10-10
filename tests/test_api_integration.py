"""Integration tests for QueryPilot FastAPI backend endpoints.

Tests health, preview, triage analysis, and export endpoints.
"""

from __future__ import annotations

import io
import json
from pathlib import Path

import pytest
from starlette.testclient import TestClient

from server import app


@pytest.fixture
def client():
    return TestClient(app)


@pytest.fixture
def sample_csv_bytes():
    csv_path = Path(__file__).resolve().parent.parent / "data" / "sample_synthetic.csv"
    with open(csv_path, "rb") as f:
        return f.read()


def test_health_endpoint(client):
    """Test that /api/health responds with status ok."""
    response = client.get("/api/health")
    assert response.status_code == 200
    data = response.json()
    assert data["status"] == "ok"
    assert "QueryPilot" in data["engine"]


def test_preview_endpoint(client, sample_csv_bytes):
    """Test CSV preview and column suggestion."""
    files = {"file": ("sample_synthetic.csv", sample_csv_bytes, "text/csv")}
    response = client.post("/api/preview", files=files)
    assert response.status_code == 200
    data = response.json()

    assert "columns" in data
    assert "suggested_mapping" in data
    assert "sample_rows" in data
    assert data["total_rows"] == 24

    # Verify suggested mapping detects required columns
    mapping = data["suggested_mapping"]
    assert mapping["search_term"] == "search_term"
    assert mapping["clicks"] == "clicks"
    assert mapping["cost"] == "cost"
    assert mapping["conversions"] == "conversions"


def test_analyze_endpoint(client, sample_csv_bytes):
    """Test full triage analysis via API."""
    files = {"file": ("sample_synthetic.csv", sample_csv_bytes, "text/csv")}
    mapping = {
        "search_term": "search_term",
        "campaign": "campaign",
        "ad_group": "ad_group",
        "match_type": "match_type",
        "impressions": "impressions",
        "clicks": "clicks",
        "cost": "cost",
        "conversions": "conversions",
        "conversion_value": "conversion_value",
    }
    data = {"column_mapping": json.dumps(mapping)}

    response = client.post("/api/analyze", files=files, data=data)
    assert response.status_code == 200
    res = response.json()

    assert "results" in res
    assert "summary" in res
    assert "quality_report" in res
    assert "decision_counts" in res
    assert "campaign_summary" in res

    # Check result counts
    assert len(res["results"]) == 24
    summary = res["summary"]
    assert summary["total_rows"] == 24
    assert summary["promote_count"] >= 1
    assert summary["block_count"] >= 1
    assert summary["ignore_count"] >= 1
    assert (
        summary["promote_count"] + summary["block_count"] + summary["ignore_count"]
        == 24
    )


def test_analyze_missing_mapping(client, sample_csv_bytes):
    """Test that omitting required fields returns 422 or error."""
    files = {"file": ("sample_synthetic.csv", sample_csv_bytes, "text/csv")}
    mapping = {
        "search_term": "search_term",
        # missing clicks, cost, conversions
    }
    data = {"column_mapping": json.dumps(mapping)}
    response = client.post("/api/analyze", files=files, data=data)
    assert response.status_code in (422, 500)


def test_export_endpoint(client, sample_csv_bytes):
    """Test exporting results to CSV."""
    # First get results
    files = {"file": ("sample_synthetic.csv", sample_csv_bytes, "text/csv")}
    mapping = {
        "search_term": "search_term",
        "campaign": "campaign",
        "ad_group": "ad_group",
        "match_type": "match_type",
        "clicks": "clicks",
        "cost": "cost",
        "conversions": "conversions",
    }
    resp = client.post("/api/analyze", files=files, data={"column_mapping": json.dumps(mapping)})
    assert resp.status_code == 200
    results = resp.json()["results"]

    # Export
    export_resp = client.post(
        "/api/export",
        data={"results": json.dumps(results)},
    )
    assert export_resp.status_code == 200
    assert "text/csv" in export_resp.headers.get("content-type", "")
    assert "attachment" in export_resp.headers.get("content-disposition", "")
    content = export_resp.text
    assert "search_term" in content
    assert "decision" in content
