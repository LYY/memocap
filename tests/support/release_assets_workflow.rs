use super::{before, require};

pub(super) fn validate(release: &str) -> Result<(), String> {
    for required in [
        "actions/download-artifact@d3f86a106a0bac45b974a628896c90dbdf5c8093",
        "pattern: release-*",
        "merge-multiple: true",
        "present=(release-assets/*)",
        "[ \"${#present[@]}\" -eq 6 ]",
        "[ -f \"$path\" ] && [ ! -L \"$path\" ]",
        "[ \"$manifest\" = \"$digest  $asset\" ]",
        "remote_tag_sha() {",
        "gh api \"repos/$GITHUB_REPOSITORY/git/ref/tags/$TAG\"",
        "[ \"$(remote_tag_sha)\" = \"$TAG_SHA\" ]",
        "gh release create \"$TAG\" \"${release_files[@]}\" --repo \"$GITHUB_REPOSITORY\" --verify-tag --target \"$TAG_SHA\"",
        "gh release upload \"$TAG\" \"${release_files[@]}\" --repo \"$GITHUB_REPOSITORY\" --clobber",
        "gh release view \"$TAG\" --repo \"$GITHUB_REPOSITORY\" --json tagName,isDraft,isPrerelease,assets",
        "[ \"$(jq -r '.isDraft' <<< \"$release\")\" = false ]",
        "[ \"$(jq -r '.isPrerelease' <<< \"$release\")\" = false ]",
        "verify_known_assets \"$release\"",
        "actual_names=\"$(jq -r '.assets[].name' <<< \"$release\" | sort)\"",
        "[ \"$actual_names\" = \"$expected_names\" ]",
        "gh release download \"$TAG\" --repo \"$GITHUB_REPOSITORY\" --dir \"$verify_directory\"",
        "cmp --silent \"release-assets/$asset\" \"$verify_directory/$asset\"",
        "sha256sum --check --strict \"${asset}.sha256\"",
    ] {
        require(release, required)?;
    }

    for asset in [
        "memocap-x86_64-unknown-linux-gnu",
        "memocap-aarch64-apple-darwin",
        "memocap-x86_64-pc-windows-msvc.exe",
    ] {
        require(release, asset)?;
        require(release, &format!("{asset}.sha256"))?;
    }

    for write in ["gh release create", "gh release upload"] {
        if release.matches(write).count() != 1 {
            return Err(format!("expected one release write via {write}"));
        }
    }
    if release.contains("gh release edit")
        || release.contains("sleep ")
        || release.contains("for attempt")
    {
        return Err("release publication may not poll or mutate release identity".to_owned());
    }

    before(
        release,
        "[ \"$manifest\" = \"$digest  $asset\" ]",
        "[ \"$(remote_tag_sha)\" = \"$TAG_SHA\" ]",
    )?;
    before(
        release,
        "[ \"$(remote_tag_sha)\" = \"$TAG_SHA\" ]",
        "gh release view \"$TAG\"",
    )?;
    before(
        release,
        "gh release view \"$TAG\"",
        "gh release upload \"$TAG\"",
    )?;
    before(
        release,
        "verify_known_assets \"$release\"",
        "gh release upload \"$TAG\"",
    )?;
    before(release, "gh release upload \"$TAG\"", "actual_names=")?;
    before(release, "gh release create \"$TAG\"", "actual_names=")?;
    before(release, "actual_names=", "gh release download \"$TAG\"")
}
