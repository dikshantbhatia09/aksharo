from __future__ import annotations

from aksharo_core_app.licence import LicenceSnapshot, check_licence_for_panel


def test_allows_an_owned_asset_licensed_for_the_panel_surface() -> None:
    result = check_licence_for_panel(
        LicenceSnapshot(allows_raw_file_delivery=True, surface=("panel", "cloud_render"))
    )
    assert result.allowed is True
    assert result.reasons == ()


def test_refuses_a_partner_asset_with_allows_raw_file_delivery_false() -> None:
    result = check_licence_for_panel(
        LicenceSnapshot(allows_raw_file_delivery=False, surface=("cloud_render",))
    )
    assert result.allowed is False
    assert "not-owned" in result.reasons
    assert "surface-not-allowed" in result.reasons


def test_refuses_an_owned_asset_whose_surface_list_omits_panel() -> None:
    result = check_licence_for_panel(
        LicenceSnapshot(allows_raw_file_delivery=True, surface=("cloud_render",))
    )
    assert result == check_licence_for_panel(
        LicenceSnapshot(allows_raw_file_delivery=True, surface=("cloud_render",))
    )
    assert result.allowed is False
    assert result.reasons == ("surface-not-allowed",)
