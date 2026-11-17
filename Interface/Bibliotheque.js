(() => {
    if (location.origin !== "http://127.0.0.1:18784" && !globalThis.sideRelayWebBridge) return;
    const bridge = (globalThis.sideRelayWebBridge ?? window.webkit.messageHandlers.signatureCompte);
    const sourceChecks = new Map();

    function node(tag, text = "", style = "") {
        const el = document.createElement(tag);
        if (text) el.textContent = text;
        if (style) el.className = style;
        return el;
    }
    function button(title, action, style = "btn btn-secondary") {
        const control = node("button", title, style);
        control.type = "button";
        control.addEventListener("click", event => {
            if (event.isTrusted) void action(control);
        });
        return control;
    }
    function feedback() {
        const status = node("p", "", "sr-app-action-status");
        status.setAttribute("role", "status");
        return status;
    }
    function formatDate(value) {
        if (!value) return "";
        const date = new Date(typeof value === "number" ? value * 1000 : value);
        return Number.isFinite(date.getTime()) ? date.toLocaleDateString(undefined, { dateStyle: "medium" }) : "";
    }
    function message(error, fallback) {
        return globalThis.sideRelayJobs?.messageErreur(error?.message, fallback) || fallback;
    }
    function readableError(error, fallback) {
        if (error instanceof Error && error.message && error.message.length <= 500) {
            return error.message.replace(/^ServerError\|/, "");
        }
        return fallback;
    }
    async function catalogue(operation, args = {}) {
        const value = await bridge.postMessage({ action: "ipaLibrary", operation, ...args });
        if (value?.error) throw new Error(value.error);
        return value;
    }
    async function upload(action, file, signal) {
        const timeout = AbortSignal.timeout(120000);
        const response = await fetch("/api/siderelay/ipa/" + action, {
            method: "POST",
            headers: { "Content-Type": "application/octet-stream", "X-SideRelay-Action": "catalogue" },
            body: file,
            redirect: "error",
            signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
        });
        if (!response.ok) {
            if (response.status === 413) throw new Error("Choose an IPA smaller than 512 MB.");
            throw new Error((await response.text()).slice(0, 500) || "Could not read the IPA.");
        }
        return response.json();
    }
    function labelled(dl, title, value) {
        if (!value) return;
        const row = node("div");
        row.append(node("dt", title), node("dd", value));
        dl.append(row);
    }
    function packageVersion(ipa) {
        if (!ipa.version) return "";
        const version = String(ipa.version);
        const build = ipa.build ? String(ipa.build) : "";
        return build && build !== version ? `${version} (${build})` : version;
    }
    const platformSymbols = new Map([
        ["iOS", "var(--icon-devices)"], ["iPadOS", "var(--icon-ipad)"],
        ["tvOS", "var(--icon-tv)"], ["watchOS", "var(--icon-watch)"],
        ["visionOS", "var(--icon-vision)"], ["macOS", "var(--icon-mac)"],
    ]);
    const bundlePlatforms = new Map([
        ["iPadOS", "iPadOS"], ["AppleTVOS", "tvOS"], ["WatchOS", "watchOS"],
        ["XROS", "visionOS"], ["MacOSX", "macOS"],
    ]);
    function buildVersion(ipa, version, summary) {
        const label = node(summary ? "span" : "strong", "", "sr-library-version-line");
        label.append(node("span", version));
        const platforms = new Set();
        const families = ipa.deviceFamilies || [];
        for (const platform of ipa.platforms || []) {
            if (platform === "iPhoneOS") {
                if (families.includes(1) || !families.includes(2)) platforms.add("iOS");
                if (families.includes(2)) platforms.add("iPadOS");
            } else if (bundlePlatforms.has(platform)) platforms.add(bundlePlatforms.get(platform));
        }
        for (const platform of platforms) {
            if (globalThis.sideRelayWebBridge) {
                label.append(node("span", platform, "sr-web-platform"));
                continue;
            }
            const symbol = node("span", "", "sr-library-platform");
            symbol.setAttribute("role", "img");
            symbol.setAttribute("aria-label", platform);
            symbol.title = platform;
            symbol.style.setProperty("--platform-symbol", platformSymbols.get(platform));
            label.append(symbol);
        }
        return label;
    }
    function installedVersion(app) {
        return packageVersion({ version: app.version, build: app.packageMetadata?.build ?? app.build });
    }
    function packageDetails(ipa) {
        const box = node("div", "", "sr-package-detail");
        const list = node("dl", "", "sr-app-details");
        labelled(list, "App", ipa.displayName);
        labelled(list, "Version", packageVersion(ipa));
        labelled(list, "Bundle ID", ipa.bundleId);
        labelled(list, "Minimum OS", ipa.minimumOs);
        labelled(list, "Platforms", ipa.platforms?.join(", "));
        labelled(list, "Extensions", String(ipa.extensions?.length ?? 0));
        box.append(list);
        if (ipa.extensions?.length) {
            const disclosure = node("details");
            disclosure.append(node("summary", "View Extensions"));
            const rows = node("ul", "", "sr-package-identifiers");
            for (const extension of ipa.extensions) {
                const row = node("li");
                row.append(node("strong", extension.name || extension.bundleId));
                if (extension.bundleId) row.append(node("small", extension.bundleId));
                if (extension.point) row.append(node("small", extension.point));
                rows.append(row);
            }
            disclosure.append(rows);
            box.append(disclosure);
        }
        return box;
    }
    async function showProfileCheck(ipa, dialog, section) {
        const status = feedback();
        const output = node("div");
        section.append(node("h3", "Installation Check"), status, output);
        const checking = globalThis.sideRelayWebBridge ? "Checking the provisioning profiles…" : "Checking the signature in this IPA…";
        status.textContent = checking;
        let device;
        try {
            const { requete } = globalThis.sideRelayJobs;
            const result = await requete("list_devices");
            if (!dialog.open) return;
            const devices = Array.isArray(result) ? result : [];
            if (devices.length) {
                device = selectField("Target Device", devices, "name");
                section.insertBefore(device.label, status);
            }
        } catch {
            if (!dialog.open) return;
        }
        let check = 0;
        async function update() {
            const request = ++check;
            const deviceId = device?.select.value ?? "";
            output.replaceChildren();
            status.textContent = checking;
            try {
                const report = await catalogue("diagnose", { packageId: ipa.id, deviceId });
                if (!dialog.open || request !== check) return;
                const issues = report.components.some(component => component.errors.length);
                status.textContent = issues ? "This IPA has provisioning issues." : report.ready
                    ? (report.profileOnly ? "Embedded profiles cover this device." : "Profile checks passed for this device.")
                    : device ? "Choose a device to check whether it’s included in the profile."
                        : "Add an iPhone or iPad in Devices to check whether it’s included in the profile.";
                for (const component of report.components) {
                    const row = node("div", "", "sr-profile-component");
                    row.append(node("strong", component.bundle));
                    const date = component.expires && new Date(component.expires).toLocaleString(
                        undefined, { dateStyle: "medium", timeStyle: "short" });
                    if (component.profile || date) {
                        row.append(node("div", [component.profile, date && `Expires ${date}`]
                            .filter(Boolean).join(" · "), "muted"));
                    }
                    if (component.errors.length || component.warnings.length) {
                        const details = node("ul");
                        for (const error of component.errors) details.append(node("li", error, "sr-profile-error"));
                        for (const warning of component.warnings) details.append(node("li", warning, "muted"));
                        row.append(details);
                    }
                    output.append(row);
                }
            } catch (error) {
                if (dialog.open && request === check) {
                    status.textContent = readableError(error, "Could not check the provisioning profile.");
                }
            }
        }
        device?.select.addEventListener("change", update);
        await update();
    }

    function showInspection(ipa, library, saved) {
        if (document.querySelector(".sr-package-dialog[open]")) return;
        const dialog = node("dialog", "", "sr-certificate-review sr-package-dialog sr-inspection");
        const title = node("h2", "IPA Details");
        title.id = "sr-inspection-title";
        dialog.setAttribute("aria-labelledby", title.id);
        const details = packageDetails(ipa);
        const metadata = [ipa.sourceName, saved && `Saved ${saved}`].filter(Boolean).join(" · ");
        if (metadata) details.append(node("p", metadata, "muted"));
        const status = feedback();
        const body = node("div");
        const profileCheck = node("section", "", "sr-profile-check");
        const actions = node("div", "", "sr-actions");
        const sign = button("Sign with Imported Profiles…", async () => {
            sign.disabled = true;
            try {
                await catalogue("signing-path", { packageId: ipa.id });
                dialog.close();
            } catch (error) {
                status.textContent = readableError(error, "Could not open the IPA Workshop.");
                sign.disabled = false;
            }
        });
        if (!globalThis.sideRelayWebBridge) actions.append(sign);
        actions.append(button("Close", () => dialog.close()));
        dialog.append(title, details, profileCheck, status, body, actions);
        dialog.addEventListener("close", () => dialog.remove(), { once: true });
        document.body.append(dialog);
        dialog.showModal();
        status.textContent = "Reading IPA…";
        void showProfileCheck(ipa, dialog, profileCheck);

        function readOnlyPlist(label, value) {
            const details = node("details", "", "sr-inspection-plist");
            const code = node("pre", value);
            code.tabIndex = 0;
            code.setAttribute("aria-label", label);
            details.append(node("summary", label), code);
            return details;
        }
        function changes(before, after, describe) {
            const names = [...new Set([...before.keys(), ...after.keys()])].sort();
            const list = node("ul", "", "sr-inspection-items");
            for (const name of names) {
                const old = before.get(name), next = after.get(name);
                const kind = old === undefined ? "Added" : next === undefined ? "Removed" : old !== next ? "Changed" : "";
                if (kind) {
                    const row = node("li");
                    row.append(node("span", name), node("span", kind, "muted"));
                    list.append(row);
                }
            }
            return list.childElementCount ? list : node("p", describe, "muted");
        }
        const inspect = packageId => catalogue("inspect", { packageId });
        void (async () => {
            try {
                const current = await inspect(ipa.id);
                if (!dialog.open) return;
                status.textContent = "";
                body.append(node("h3", "Frameworks and Dynamic Libraries"));
                if (!current.components.length) body.append(node("p", "No frameworks or dynamic libraries.", "muted"));
                else {
                    const list = node("ul", "", "sr-inspection-items");
                    for (const item of current.components) {
                        const row = node("li");
                        row.append(node("span", item.path), node("span", item.kind, "muted"));
                        list.append(row);
                    }
                    body.append(list);
                }
                body.append(readOnlyPlist("View Info.plist", current.plist));
                const versions = library.filter(item => item.available && item.id !== ipa.id && item.bundleId === ipa.bundleId);
                if (!versions.length) return;
                const { label, select } = selectField("Compare Against", versions.map(item => ({
                    id: item.id, label: [packageVersion(item), formatDate(item.importedAt), item.id.slice(0, 8)].filter(Boolean).join(" · "),
                })), "label");
                select.value = "";
                const output = node("div");
                body.append(node("h3", "Compare Builds"), label, output);
                let version = 0;
                select.addEventListener("change", async () => {
                    const request = ++version;
                    output.replaceChildren();
                    if (!select.value) return;
                    const previous = versions.find(item => item.id === select.value);
                    output.append(node("p", "Comparing builds…", "muted"));
                    try {
                        const baseline = await inspect(previous.id);
                        if (!dialog.open || request !== version) return;
                        const componentMap = file => new Map(file.components.map(item => [item.path, item.digest]));
                        const keys = file => new Map(Object.entries(file.keys));
                        output.replaceChildren(
                            node("p", `${packageVersion(previous)} → ${packageVersion(ipa)}`, "muted"),
                            node("h3", "Changed Components"),
                            changes(componentMap(baseline), componentMap(current), "No component changes."),
                            node("h3", "Changed Info.plist Keys"),
                            changes(keys(baseline), keys(current), "No Info.plist changes."),
                            readOnlyPlist("View Comparison Info.plist", baseline.plist),
                        );
                    } catch (error) {
                        if (request === version) output.replaceChildren(node("p",
                            readableError(error, "Could not compare builds."), "sr-app-issue"));
                    }
                });
            } catch (error) {
                if (dialog.open) status.textContent = readableError(error, "Could not read IPA contents.");
            }
        })();
    }

    function originalBundle(app, packages = []) {
        const origin = app.packageMetadata?.bundleId || packages.find(item => item.id === app.packageID)?.bundleId;
        if (origin) return origin;
        const suffix = app.accountTeam ? "." + app.accountTeam : "";
        return suffix && app.bundleID.endsWith(suffix) ? app.bundleID.slice(0, -suffix.length) : app.bundleID;
    }
    function comparison(ipa, apps, device, account, target, packages = []) {
        if (!device || !account) return { text: "" };
        const installed = apps.filter(app => app.installedAt && app.deviceID === device);
        const matches = installed.filter(app => originalBundle(app, packages) === ipa.bundleId || app.bundleID === ipa.bundleId);
        const match = target || matches.find(app => app.accountID === account);
        if (match) {
            if (target && !matches.some(app => app.id === target.id)) {
                return { text: "The Bundle ID does not match this installed app.", blocked: true };
            }
            const version = installedVersion(match);
            return { text: `Updates ${[match.name, version].filter(Boolean).join(" ")} on this device.`, target: match };
        }
        const similar = installed.find(app => app.name?.toLowerCase() === ipa.displayName?.toLowerCase());
        if (matches.length || similar) {
            return { text: "This IPA may install as a separate app. Review the Bundle ID and Apple Account.", warning: true };
        }
        return { text: "Installs a new app on this device." };
    }
    async function installedApps() {
        const result = await bridge.postMessage({ action: "appsCatalog" });
        return result.apps || [];
    }
    function selectField(title, rows, prop) {
        const label = node("label", title, "form-field");
        const select = node("select");
        select.append(new Option("Choose…", ""), ...rows.map(row => new Option(row[prop], row.id)));
        if (rows.length === 1) select.value = rows[0].id;
        label.append(select);
        return { label, select };
    }

    function compatibleTargets(devices, ipa, deviceVersions = {}) {
        return globalThis.sideRelayIPAPlatforms.targetDevices(devices, ipa).filter(device => {
            const os = deviceVersions[device.id];
            return !os || !ipa.minimumOs || versionCompare(os, ipa.minimumOs) >= 0;
        });
    }
    async function confirmInstall(ipa, { target, refresh, library = [], trigger, targets } = {}) {
        if (document.querySelector(".sr-package-dialog[open]")) return;
        if (globalThis.sideRelayIPAPlatforms.requiresMac(ipa)) {
            globalThis.sideRelayWebBridge.downloadIPA(ipa.id);
            return;
        }
        const dialog = node("dialog", "", "sr-certificate-review sr-package-dialog sr-package-review");
        const header = node("header", "", "sr-package-review-header");
        const body = node("div", "", "sr-package-review-body");
        const { isTVApp, targetDevices } = globalThis.sideRelayIPAPlatforms;
        const platform = isTVApp(ipa) ? "Apple TV" : "iPhone or iPad";
        const title = node("h2", "Review Installation");
        title.id = "sr-package-dialog-title";
        dialog.setAttribute("aria-labelledby", title.id);
        header.append(title);
        body.append(packageDetails(ipa));
        const fields = node("div", "", "sr-package-targets");
        const status = feedback();
        status.classList.add("sr-install-comparison");
        const close = button("Cancel", () => dialog.close());
        const actions = node("footer", "", "sr-actions sr-package-review-footer");
        const operationStatus = node("span", "", "sr-package-operation-announcement");
        operationStatus.setAttribute("role", "status");
        let submit;
        const install = button("", () => submit?.(), "btn btn-primary sr-package-operation");
        const installLabel = node("span");
        install.append(installLabel);
        const actionLabel = "Install";
        const retryLabel = "Retry Install";
        function setOperation(state, label, announcement = label) {
            install.dataset.state = state;
            if (installLabel.textContent !== label) installLabel.textContent = label;
            if (operationStatus.textContent !== announcement) operationStatus.textContent = announcement;
            install.title = announcement === label ? "" : announcement;
            install.disabled = ["pending", "success", "unavailable", "quota"].includes(state);
        }
        setOperation("pending", "Loading…", "Loading devices and Apple Accounts.");
        const errorDetails = node("details", "", "sr-package-operation-error");
        const errorMessage = node("p");
        const activityLink = node("a", "Open Activity", "sr-link");
        activityLink.href = "/queue";
        errorDetails.append(node("summary", "Error Details"), errorMessage, activityLink);
        errorDetails.hidden = true;
        const showError = (detail, showActivity) => {
            errorMessage.textContent = detail;
            activityLink.hidden = !showActivity;
            errorDetails.hidden = false;
        };
        actions.append(close, install, operationStatus);
        const ids = node("section", "", "sr-app-id-preview");
        const idsTitle = node("h3", "App IDs");
        const idsList = node("ul", "", "sr-app-id-list");
        const reuse = node("input");
        reuse.type = "checkbox";
        const reuseLabel = node("label", "", "sr-app-ipa-refresh sr-shared-app-id");
        reuseLabel.append(reuse, "Use Existing iOS App ID");
        reuseLabel.hidden = true;
        const manageIDs = node("a", "Manage App IDs…", "sr-link");
        manageIDs.hidden = true;
        let assignedBundle;
        const profile = globalThis.sideRelayProfileChoice({
            statusChanged: () => redrawIDs?.(), useSharedId: id => reuse.checked || assignedBundle === id,
        });
        reuse.addEventListener("change", profile.render);
        const idsStatus = profile.quota;
        let redrawIDs;
        ids.append(idsTitle, reuseLabel, profile.bloc, idsList, manageIDs);
        if (ipa.extensions?.length) {
            ids.append(button("Edit Extensions…", async control => {
                control.disabled = true;
                try {
                    await catalogue("edit-path", { packageId: ipa.id });
                    dialog.close();
                } catch (error) {
                    idsStatus.textContent = readableError(error, "Could not open the IPA Workshop.");
                    control.disabled = false;
                }
            }, "sr-link"));
        }
        const native = node("div", "", "sr-native-ipa-fields sr-package-install-native");
        const alternatives = node("div", "", "sr-install-alternatives");
        native.append(fields, ids, status, alternatives, errorDetails);
        let mode;
        let checkCurrentIDs;
        let tvDestination;
        if (!target && isTVApp(ipa) && (!globalThis.sideRelayWebBridge || globalThis.sideRelayWebBridge.appleTV)) {
            const label = node("label", "Destination", "form-field sr-ipa-destination");
            tvDestination = node("select");
            tvDestination.append(new Option("Install as a Separate App", "native"),
                new Option("Install in TVContainer", "tvcontainer"));
            label.append(tvDestination);
            body.append(label);
        }
        if (!target && !isTVApp(ipa) && (!globalThis.sideRelayWebBridge || globalThis.sideRelayWebBridge.liveContainer)) {
            const { destinationIPA, transfertLiveContainer } = globalThis.sideRelayIPADestination;
            const destination = destinationIPA();
            mode = destination.select;
            const transfert = transfertLiveContainer({
                paquet: () => ipa, format: () => ipa,
                actif: sending => { mode.disabled = sending; },
            });
            mode.addEventListener("change", () => {
                const live = mode.value === "livecontainer";
                native.hidden = live;
                install.hidden = operationStatus.hidden = live;
                transfert.bloc.hidden = !live;
                if (live) { void profile.check(null); transfert.actualiser(); }
                else void checkCurrentIDs?.();
            });
            body.append(destination.label, transfert.bloc);
        }
        body.append(native);
        dialog.append(header, body, actions);
        dialog.addEventListener("close", () => {
            dialog.remove();
            if (trigger?.isConnected) trigger.focus();
        }, { once: true });
        document.body.append(dialog);
        dialog.showModal();
        const { requete, suivreJob } = globalThis.sideRelayJobs;
        try {
            const [allDevices, accounts, apps, deviceVersions] = await Promise.all([
                targets?.devices ?? requete("list_devices"), targets?.accounts ?? requete("list_accounts"),
                installedApps(), targets?.deviceVersions ?? (ipa.minimumOs
                    ? bridge.postMessage({ action: "installDeviceVersions" }).catch(() => ({})) : {}),
            ]);
            if (!dialog.open) return;
            const platformDevices = targetDevices(allDevices, ipa);
            const devices = compatibleTargets(allDevices, ipa, deviceVersions);
            const device = selectField(platform, devices, "name");
            const account = selectField("Apple Account", accounts, "apple_id");
            if (target) {
                device.select.value = target.deviceID;
                account.select.value = target.accountID || "";
                device.select.disabled = account.select.disabled = true;
            }
            fields.append(device.label, account.label);
            let installing = false;
            let lastTarget;
            let lastError = "";
            let searching = false;
            let installChoice = 0;
            const usesTVContainer = () => tvDestination?.value === "tvcontainer";
            function clearAlternatives() {
                installChoice++;
                lastError = "";
                alternatives.replaceChildren();
                alternatives.hidden = true;
            }
            function suggest() {
                alternatives.replaceChildren();
                const actions = node("div", "", "sr-actions");
                const note = node("p", "", "muted");
                note.setAttribute("role", "status");
                const appOnDevice = compare().target;
                const blocked = profile.blocked || lastError === "app-id-limit";
                const plan = profile.result;
                if (!devices.length) {
                    const needsPairing = platformDevices.length === 0;
                    note.textContent = needsPairing ? `Pair an ${platform} before installing.`
                        : `This build requires ${isTVApp(ipa) ? "tvOS" : "iOS or iPadOS"} ${ipa.minimumOs} or later.`;
                    const link = node("a", needsPairing ? "Open Devices" : "Check Devices", "sr-link");
                    link.href = "/devices";
                    actions.append(link);
                } else if (!accounts.length || lastError === "apple-account") {
                    const link = node("a", lastError ? "Reconnect Apple Account" : "Connect Apple Account", "sr-link");
                    link.href = "/accounts";
                    actions.append(link);
                } else if (blocked) {
                    const sharedRows = plan?.sharedRows ?? plan?.rows?.filter(row => row.extension) ?? [];
                    const sharedNew = sharedRows.filter(row => !row.registered && (!profile.selected || !row.extension)).length;
                    if (!reuseLabel.hidden && !reuse.checked && plan?.sharedIosId &&
                        Number.isInteger(plan.available) && sharedNew <= plan.available) {
                        actions.append(button("Reuse Existing App ID", () => {
                            lastError = "";
                            reuse.checked = true;
                            profile.render();
                        }));
                    }
                    if (!target && !appOnDevice && accounts.some(item => item.id !== account.select.value)) {
                        actions.append(button("Find Another Account", async control => {
                            if (searching) return;
                            searching = control.disabled = true;
                            const selection = installChoice;
                            note.textContent = "Checking App IDs on your other accounts…";
                            try {
                                for (const other of accounts.filter(item => item.id !== account.select.value)) {
                                    const check = await requete("preview_app_ids", {
                                        package_id: ipa.id, account_id: other.id,
                                    }, AbortSignal.timeout(45000)).catch(() => null);
                                    if (!dialog.open || selection !== installChoice || !note.isConnected) return;
                                    if (!check || !Number.isInteger(check.new) ||
                                        (check.new > 0 && (!Number.isInteger(check.available) || check.new > check.available))) continue;
                                    const useAccount = button(`Use ${other.apple_id}`, () => {
                                        account.select.value = other.id;
                                        void checkIDs();
                                    }, "btn btn-primary");
                                    control.replaceWith(useAccount);
                                    note.textContent = globalThis.sideRelayJobs.appIDQuota(check.new, check.available).text;
                                    return;
                                }
                                note.textContent = "SideRelay couldn’t verify enough App IDs on another account.";
                            } finally {
                                searching = false;
                                control.disabled = false;
                            }
                        }));
                    }
                }
                if (mode && !appOnDevice && (blocked || lastError === "install-limit") &&
                    apps.some(app => app.deviceID === device.select.value && app.installedAt &&
                        /^com\.kdt\.livecontainer(?:\.|$)/i.test(originalBundle(app, library)))) {
                    actions.append(button("Try LiveContainer", () => {
                        mode.value = "livecontainer";
                        mode.dispatchEvent(new Event("change"));
                    }));
                }
                if (lastError === "install-limit" && !note.textContent) {
                    note.textContent = "Free a development app slot on the device to install this as a separate app.";
                }
                alternatives.hidden = !actions.childElementCount && !note.textContent;
                if (!alternatives.hidden) alternatives.append(actions, note);
            }
            function openActivity(detail) {
                setOperation("activity", "Check Activity", detail);
                submit = () => { location.href = "/queue"; };
            }
            submit = async () => {
                if (usesTVContainer()) {
                    if (installing || !device.select.value) return;
                    installing = tvDestination.disabled = device.select.disabled = true;
                    errorDetails.hidden = true;
                    close.textContent = "Close";
                    setOperation("pending", "Installing…");
                    try {
                        const result = await bridge.postMessage({ action: "importTVContainer",
                            deviceId: device.select.value, packageId: ipa.id });
                        if (!dialog.open) return;
                        if (!result?.installed) throw new Error(result?.error || "TVContainer did not confirm the import.");
                        setOperation("success", "Installed in TVContainer");
                    } catch (error) {
                        if (!dialog.open) return;
                        const detail = readableError(error, "Could not install in TVContainer.");
                        setOperation("retry", "Retry Install", detail);
                        showError(detail, false);
                        installing = tvDestination.disabled = device.select.disabled = false;
                    }
                    return;
                }
                const result = compare();
                if (install.disabled || installing || result.blocked || profile.blocked || profile.pending ||
                    !device.select.value || !account.select.value) return;
                const useMain = profile.selected;
                const shared = reuse.checked && profile.result?.sharedIosId;
                installing = true;
                reuse.disabled = true;
                profile.enabled = false;
                if (mode) mode.disabled = true;
                device.select.disabled = account.select.disabled = true;
                close.textContent = "Close";
                status.textContent = "";
                errorDetails.hidden = true;
                errorDetails.open = false;
                setOperation("pending", "Queuing…");
                let submitted = false;
                let retryable = false;
                try {
                    const id = await requete("install_library_ipa", {
                        package_id: ipa.id,
                        device_id: device.select.value,
                        account_id: account.select.value,
                        target_app_id: result.target?.id || "",
                        use_main_profile: String(useMain),
                        ...(shared ? { reuse_app_id: shared } : {}),
                    }, AbortSignal.timeout(120000));
                    if (typeof id !== "string" || !id) throw new Error("Invalid installation response.");
                    submitted = true;
                    if (dialog.open) setOperation("pending", "Queued…");
                    const job = await suivreJob(id, () => dialog.open, item => {
                        if (item.status === "running") setOperation("pending", "Installing…");
                        else setOperation("pending", "Queued…");
                    });
                    if (dialog.open) {
                        const cancelled = ["cancelled", "canceled"].includes(job?.status);
                        if (job?.status === "done") {
                            setOperation("success", "Installed");
                            if (document.activeElement === install || !dialog.contains(document.activeElement)) {
                                close.focus({ preventScroll: true });
                            }
                        } else if (job?.status === "failed") {
                            retryable = true;
                            lastError = globalThis.sideRelayJobs.typeErreur(job.error);
                            const detail = message({ message: job.error }, "Installation failed.");
                            setOperation("retry", retryLabel, detail);
                            showError(detail, true);
                            if (globalThis.sideRelayJobs.typeErreur(job.error) === "main-profile-verification") {
                                profile.enabled = true;
                                profile.input.focus();
                            }
                        } else if (cancelled) {
                            retryable = true;
                            setOperation("ready", retryLabel, "Installation cancelled.");
                        } else {
                            openActivity("Installation is still in progress.");
                        }
                    }
                    void refresh?.();
                } catch (error) {
                    if (!dialog.open) return;
                    const rejected = !submitted && error.http >= 400 && error.http < 500;
                    retryable = rejected;
                    if (rejected) lastError = globalThis.sideRelayJobs.typeErreur(error.message);
                    const detail = message(error, rejected ? readableError(error, "Could not queue the request. Check the selection and try again.")
                        : "Could not confirm the result. Check Activity before retrying.");
                    if (rejected) setOperation("retry", retryLabel, detail);
                    else openActivity(detail);
                    showError(detail, false);
                } finally {
                    if (dialog.open && retryable) {
                        installing = false;
                        reuse.disabled = false;
                        profile.enabled = true;
                        if (mode) mode.disabled = false;
                        device.select.disabled = account.select.disabled = Boolean(target);
                        close.textContent = "Cancel";
                        update(true);
                    }
                }
            };
            function compare() {
                return comparison(ipa, apps, device.select.value, account.select.value, target, library);
            }
            function update(keepStatus = false) {
                if (installing) return;
                if (usesTVContainer()) {
                    setOperation("ready", "Install in TVContainer");
                    install.disabled = !device.select.value;
                    return;
                }
                const result = compare();
                if (!keepStatus) {
                    status.textContent = result.text || (devices.length && accounts.length
                        ? `Select an ${platform} and Apple Account.` : `Add an ${platform} and Apple Account to install.`);
                }
                status.classList.toggle("sr-app-issue", Boolean(result.warning || result.blocked));
                idsStatus.hidden = profile.pending;
                suggest();
                if (profile.pending) {
                    setOperation("pending", "Checking…", "Checking App IDs with Apple.");
                    return;
                }
                if (profile.blocked) {
                    setOperation("quota", "App ID Limit", "This Apple Account has too few App IDs available for this IPA.");
                    return;
                }
                if (["pending", "quota"].includes(install.dataset.state)) setOperation("ready", actionLabel);
                install.disabled = !device.select.value || !account.select.value || Boolean(result.blocked);
            }
            async function checkIDs() {
                if (mode?.value === "livecontainer") return;
                if (usesTVContainer()) { update(); return; }
                clearAlternatives();
                const current = compare().target;
                assignedBundle = current?.bundleID;
                reuse.checked = false;
                if ((current?.id ?? null) !== lastTarget) {
                    lastTarget = current?.id ?? null;
                    profile.input.checked = Boolean(current?.useMainProfile);
                }
                update();
                await profile.check(ipa, account.select.value);
            }
            redrawIDs = () => {
                if (usesTVContainer()) return;
                if (!dialog.open) return;
                reuseLabel.hidden = !profile.result?.sharedIosId || !device.select.value || Boolean(compare().target);
                manageIDs.hidden = !profile.blocked || !account.select.value;
                manageIDs.href = `/accounts?appIDs=${encodeURIComponent(account.select.value)}`;
                idsList.replaceChildren();
                for (const entry of profile.result?.rows || []) {
                    const row = node("li");
                    const name = node("span", entry.extension ? `${entry.name} · Extension` : entry.name);
                    name.append(node("small", entry.identifier));
                    const state = profile.selected && entry.extension ? "Uses Main Profile" : entry.registered ? "Reused" : "To create";
                    row.append(name, node("span", state, "muted"));
                    idsList.append(row);
                }
                update(true);
            };
            device.select.addEventListener("change", checkIDs);
            account.select.addEventListener("change", checkIDs);
            tvDestination?.addEventListener("change", () => {
                const useContainer = usesTVContainer();
                account.label.hidden = ids.hidden = status.hidden = useContainer;
                errorDetails.hidden = true;
                clearAlternatives();
                setOperation("ready", useContainer ? "Install in TVContainer" : actionLabel);
                void checkIDs();
            });
            setOperation("ready", actionLabel);
            checkCurrentIDs = checkIDs;
            void checkIDs();
        } catch {
            setOperation("unavailable", "Unavailable", "Could not load devices or Apple Accounts.");
            showError("Could not load devices or Apple Accounts.", false);
        }
    }
    function versionCompare(left, right) {
        function parts(value) {
            if (typeof value !== "string" || !/^\d+(?:\.\d+)*$/.test(value)) return null;
            return value.split(".").map(Number);
        }
        const a = parts(left), b = parts(right);
        if (!a || !b) return 0;
        for (let i = 0; i < Math.max(a.length, b.length); i++) {
            const difference = (a[i] || 0) - (b[i] || 0);
            if (difference) return Math.sign(difference);
        }
        return 0;
    }
    function isNewerBuild(release, app, packages) {
        const installedBuild = app.packageMetadata?.build || packages.find(item => item.id === app.packageID)?.build;
        return versionCompare(release.version, app.version) > 0 ||
            (release.version === app.version && versionCompare(release.build, installedBuild) > 0);
    }
    function newRelease(app, sources, packages) {
        if (!app.installedAt || !app.version) return null;
        const bundle = originalBundle(app, packages);
        const isNewer = release => isNewerBuild(release, app, packages);
        const newer = packages.filter(ipa => app.accountID && ipa.available && ipa.id !== app.packageID &&
            (ipa.bundleId === bundle || ipa.bundleId === app.bundleID) &&
            (app.appleTV ? globalThis.sideRelayIPAPlatforms.isTVApp(ipa)
                : !ipa.platforms?.length || ipa.platforms.includes("iPhoneOS")) && isNewer(ipa))
            .map(ipa => ({ ipa, release: ipa }));
        for (const source of sources) {
            const item = source.apps.find(entry => entry.bundleId === bundle);
            for (const release of item?.versions || []) {
                if (Boolean(release.platform === "tvOS") === Boolean(app.appleTV) && !release.restricted && isNewer(release)) {
                    newer.push({ source, item, release });
                }
            }
        }
        return newer.sort((a, b) => versionCompare(b.release.version, a.release.version) ||
            versionCompare(b.release.build, a.release.build) || Number(Boolean(b.ipa)) - Number(Boolean(a.ipa)))[0] || null;
    }

    function updateAppearance(control, app, offer, state) {
        const next = offer && packageVersion(offer.release);
        const label = `Update ${app.name || app.bundleID}${next ? ` to ${next}` : ""}`;
        control.dataset.updateState = state?.kind || "ready";
        const text = state?.label || "Update";
        if (control.textContent !== text) control.textContent = text;
        control.title = state?.detail || label;
        control.setAttribute("aria-label", state ? `${app.name || app.bundleID}: ${state.label}${state.detail ? `. ${state.detail}` : ""}` : label);
        control.setAttribute("aria-busy", String(state?.kind === "pending"));
        control.disabled = state?.kind === "pending" || state?.kind === "success" || Boolean(app.activeJob);
    }

    function mount(section, installed, inbox, refreshApps, canRefreshApps, onLibraryChange, getInstalledApps, header) {
        let model = { packages: [], sources: [] };
        let loaded = false;
        let tab = "Installed";
        let version = 0;
        const selection = new Set();
        const expandedBuilds = new Set();
        const updateStates = new Map();

        function updateState(app, offer) {
            return updateStates.get(app.id) || (offer && app.activeJob === "install"
                ? { kind: "pending", label: "Updating…" } : null);
        }

        async function updateInstalled(target, offer, redraw = () => {}) {
            const state = updateState(target, offer);
            if (state?.kind === "activity") { location.href = "/queue"; return; }
            if (state?.kind === "quota") { location.href = `/accounts?appIDs=${encodeURIComponent(target.accountID)}`; return; }
            if (!offer || target.activeJob || ["pending", "success"].includes(state?.kind)) return;
            function show(kind, label, detail) {
                const value = { kind, label, detail };
                updateStates.set(target.id, value);
                onLibraryChange();
                redraw();
                if (kind === "success") setTimeout(() => {
                    if (updateStates.get(target.id) === value) {
                        updateStates.delete(target.id);
                        onLibraryChange();
                        redraw();
                        if (section.isConnected && tab === "Library") render();
                    }
                }, 5000);
            }
            show("pending", "Updating…");
            const { requete, suivreJob, typeErreur } = globalThis.sideRelayJobs;
            let queued = false, submitting = false;
            try {
                const current = (await installedApps()).find(app => app.id === target.id);
                if (!current?.installedAt || current.accountID !== target.accountID || current.deviceID !== target.deviceID) {
                    throw new Error("The app’s device or Apple Account changed. Refresh the list and try again.");
                }
                if (current.activeJob) { show("activity", "Check Activity", "Another operation for this app is in progress."); return; }
                if (!isNewerBuild(offer.release, current, model.packages)) { show("success", "Updated"); return; }
                let ipa = offer.ipa || await catalogue("download", { sourceId: offer.source.id,
                    bundleId: offer.item.bundleId, versionId: offer.release.id });
                const { isTVApp } = globalThis.sideRelayIPAPlatforms;
                if (!comparison(ipa, [current], current.deviceID, current.accountID, current, model.packages).target ||
                    Boolean(isTVApp(ipa)) !== Boolean(current.appleTV)) {
                    throw new Error("The new IPA does not match this installed app and device.");
                }
                const profile = globalThis.sideRelayProfileChoice({ useSharedId: id => current.bundleID === id });
                profile.input.checked = Boolean(current.useMainProfile);
                await profile.check(ipa, current.accountID);
                if (profile.blocked) {
                    const prepared = current.appleTV && await catalogue("prepare-top-shelf-update", {
                        packageId: ipa.id, appId: current.id,
                    });
                    if (!prepared?.id) { show("quota", "App ID Limit", "Manage App IDs for this Apple Account."); return; }
                    ipa = prepared;
                }
                submitting = true;
                const id = await requete("install_library_ipa", {
                    package_id: ipa.id, device_id: current.deviceID, account_id: current.accountID,
                    target_app_id: current.id, use_main_profile: String(profile.selected),
                }, AbortSignal.timeout(120000));
                if (typeof id !== "string" || !id) throw new Error("Invalid installation response.");
                queued = true;
                const job = await suivreJob(id, () => section.isConnected, () => {});
                if (job?.status === "done") show("success", "Updated");
                else if (job?.status === "failed") {
                    const detail = message({ message: job.error }, job.error || "Update failed. See Activity for details.");
                    if (typeErreur(job.error) === "app-id-limit") show("quota", "App ID Limit", detail);
                    else show("retry", "Retry Update", detail);
                } else if (["cancelled", "canceled"].includes(job?.status)) show("retry", "Retry Update", "Update cancelled.");
                else show("activity", "Check Activity", "Update is still in progress.");
            } catch (error) {
                if (typeErreur(error?.message) === "app-id-limit") show("quota", "App ID Limit", message(error, "Manage App IDs."));
                else if (queued || (submitting && !(error.http >= 400 && error.http < 500))) {
                    show("activity", "Check Activity", "Could not confirm the update. Check Activity before retrying.");
                } else show("retry", "Retry Update", message(error, readableError(error, "Could not start the update.")));
            } finally {
                if (section.isConnected) void refreshApps();
            }
        }

        function updateControls(choices, style) {
            const group = node("div", "", "sr-library-update-controls");
            const announcement = node("span", "", "sr-package-operation-announcement");
            announcement.setAttribute("role", "status");
            const device = choices.length > 1 && selectField("Device", choices.map(({ target }) => ({
                id: target.id, label: [target.device, target.account].filter(Boolean).join(" · "),
            })), "label");
            const selected = () => device ? choices.find(({ target }) => target.id === device.select.value) : choices[0];
            const update = button("Update", () => {
                const choice = selected();
                if (choice) return updateInstalled(choice.target, choice.release, redraw);
            }, style);
            function redraw() {
                const choice = selected();
                const state = choice && updateState(choice.target, choice.release);
                if (choice) updateAppearance(update, choice.target, choice.release, state);
                else update.disabled = true;
                const notice = state ? [state.label, state.detail].filter(Boolean).join(". ") : "";
                if (announcement.textContent !== notice) announcement.textContent = notice;
                if (device) device.select.disabled = choices.some(({ target }) => updateStates.get(target.id)?.kind === "pending");
            }
            if (device) {
                device.select.options[0].textContent = "Choose Device…";
                device.select.addEventListener("change", redraw);
                group.append(device.label);
            }
            group.append(update, announcement);
            redraw();
            return group;
        }
        const savedDate = new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" });
        const libraryIcons = new Map();
        const iconObserver = new IntersectionObserver(entries => {
            for (const { target, isIntersecting } of entries) {
                if (!isIntersecting) continue;
                iconObserver.unobserve(target);
                const packageId = target.dataset.packageId;
                if (!libraryIcons.has(packageId)) {
                    libraryIcons.set(packageId, catalogue("icon", { packageId }).catch(() => {
                        libraryIcons.delete(packageId);
                        return {};
                    }));
                }
                void libraryIcons.get(packageId).then(({ png }) => {
                    if (!target.isConnected || !png) return;
                    const image = node("img");
                    image.alt = "";
                    image.addEventListener("load", () => target.replaceChildren(image), { once: true });
                    image.src = `data:image/png;base64,${png}`;
                });
            }
        });
        function packageIcon(ipa) {
            const icon = node("span", "", "sr-library-icon");
            icon.setAttribute("aria-hidden", "true");
            icon.append(node("span"));
            if (ipa.available) {
                icon.dataset.packageId = ipa.id;
                iconObserver.observe(icon);
            }
            return icon;
        }
        const batches = globalThis.sideRelayBatchController({
            node, button, feedback, selectField, comparison, packageDetails, packageVersion, installedApps,
        });
        const toolbar = node("div", "", "sr-catalogue-toolbar");
        const inboxStatus = feedback();
        const inboxRows = node("ul", "", "sr-library-card sr-inbox-rows");
        inboxRows.setAttribute("aria-live", "polite");
        inbox.setAttribute("aria-label", "IPA Inbox");
        inbox.append(node("h2", "IPA Inbox", "sr-app-group-title"), inboxRows);
        const navigation = node("div", "", "sr-catalogue-tabs");
        navigation.setAttribute("role", "group");
        navigation.setAttribute("aria-label", "Apps view");
        const input = node("input");
        input.type = "file";
        input.accept = ".ipa";
        input.hidden = true;
        const add = button("Import IPA…", () => input.click(), "btn btn-primary");
        const more = button("", openActions, "btn btn-secondary sr-catalogue-more");
        more.append(node("span", "More", "sr-catalogue-more-label"));
        more.setAttribute("aria-label", "More app actions");
        more.setAttribute("aria-haspopup", "menu");
        more.title = "More App Actions";
        const commands = node("div", "", "sr-actions sr-catalogue-commands");
        commands.append(add, more, input);
        toolbar.append(navigation, commands);
        const content = node("section", "", "sr-library-pane");
        content.hidden = true;
        const status = feedback();
        const rows = node("div", "", "sr-library-rows");
        content.append(rows);
        const tabs = new Map();
        for (const name of ["Installed", "Library"]) {
            const control = button(name, () => select(name), "btn");
            tabs.set(name, control);
            navigation.append(control);
        }
        header.append(toolbar);
        section.prepend(status, inboxStatus);
        section.append(content);

        function select(name) {
            tab = name;
            toolbar.dataset.view = tab;
            void bridge.postMessage({ action: "libraryDropEnabled", enabled: tab === "Library" ? "yes" : "no" }).catch(() => {});
            add.hidden = tab !== "Library";
            installed.hidden = tab !== "Installed";
            content.hidden = tab === "Installed";
            status.textContent = "";
            for (const [key, control] of tabs) control.setAttribute("aria-pressed", String(tab === key));
            if (tab === "Library") {
                render();
                if (!loaded) void refreshLibrary();
            } else renderInbox();
        }
        let menuOpen = false;
        async function openActions(control) {
            if (menuOpen) return;
            menuOpen = true;
            const view = tab;
            const bounds = control.getBoundingClientRect();
            try {
                const action = await bridge.postMessage({
                    action: "appsActions", view, refresh: canRefreshApps() ? "1" : "0",
                    x: String(bounds.left), y: String(bounds.bottom),
                });
                if (!section.isConnected || tab !== view) return;
                if (action === "companion") await globalThis.sideRelayIPADestination.setupCompanion(undefined, { onDone: refreshApps });
                if (action === "workshop") await bridge.postMessage({ action });
                if (action === "refresh" && canRefreshApps()) await refreshApps();
                if (view !== "Library") return;
                if (action === "batches") await batches.history(refreshApps);
                if (action === "importBuild") {
                    status.textContent = "";
                    await importedBuild(await bridge.postMessage({ action: "chooseXcodeBuild" }));
                }
            } catch (error) {
                status.textContent = readableError(error, "Could not complete the app action.");
            } finally { menuOpen = false; }
        }
        async function refreshLibrary() {
            const request = ++version;
            try {
                const result = await catalogue("list");
                if (!section.isConnected || request !== version) return;
                model = result;
                loaded = true;
                const issue = result.inbox?.errors?.[0];
                const inboxFeedback = issue ? `IPA Inbox · ${issue.file} · ${issue.message}` : "";
                if (inboxStatus.textContent !== inboxFeedback) inboxStatus.textContent = inboxFeedback;
                if (tab === "Library") render();
                else renderInbox();
                onLibraryChange();
            } catch (error) {
                if (tab !== "Installed" && request === version) {
                    status.textContent = readableError(error, "Could not load the library or sources.");
                }
            }
        }
        function watchInbox() {
            let checking = false;
            const timer = setInterval(async () => {
                if (!section.isConnected) { clearInterval(timer); return; }
                if (!loaded || document.hidden || checking) return;
                checking = true;
                try {
                    if (getInstalledApps().some(app => app.activeJob === "install" && updateStates.get(app.id)?.kind !== "pending")) {
                        await refreshApps();
                        return;
                    }
                    const state = await catalogue("inbox");
                    if (section.isConnected && state.revision !== model.inbox?.revision) {
                        await refreshLibrary();
                    }
                } catch {
                    // The local service may be restarting. Try again on the next check.
                } finally { checking = false; }
            }, 5000);
        }
        function renderInbox() {
            if (tab !== "Installed") return;
            const { isTVApp, requiresMac } = globalThis.sideRelayIPAPlatforms;
            const key = (bundle, tv) => `${tv ? "tvOS" : "iOS"}/${bundle}`;
            const installedBundles = new Set(getInstalledApps().flatMap(app => [
                key(originalBundle(app, model.packages), app.appleTV), key(app.bundleID, app.appleTV),
            ]));
            const detected = new Set(model.inbox?.packageIds);
            const latest = new Map();
            for (const ipa of model.packages) {
                if (!detected.has(ipa.id) || !ipa.available || !ipa.bundleId || ipa.installations?.length) continue;
                const appKey = key(ipa.bundleId, isTVApp(ipa));
                if (installedBundles.has(appKey)) continue;
                const current = latest.get(appKey);
                if (!current || (versionCompare(ipa.version, current.version) || versionCompare(ipa.build, current.build)) > 0) {
                    latest.set(appKey, ipa);
                }
            }
            const packages = [...latest.values()].sort((a, b) =>
                a.displayName.localeCompare(b.displayName, undefined, { sensitivity: "base" }));
            inbox.hidden = !packages.length;
            const existing = [...inboxRows.children];
            if (packages.length === existing.length && packages.every((ipa, index) => existing[index].dataset.ipa === ipa.id)) return;
            const byId = new Map(existing.map(row => [row.dataset.ipa, row]));
            const keep = new Set(packages.map(ipa => ipa.id));
            for (const [id, row] of byId) {
                if (!keep.has(id)) iconObserver.unobserve(row.querySelector(".sr-library-icon"));
            }
            const focused = inboxRows.contains(document.activeElement) ? document.activeElement : null;
            inboxRows.replaceChildren(...packages.map(ipa => {
                const existingRow = byId.get(ipa.id);
                if (existingRow) return existingRow;
                const row = node("li", "", "sr-inbox-row");
                row.dataset.ipa = ipa.id;
                const identity = node("div", "", "sr-app-identity");
                const labels = node("div", "", "sr-app-names");
                const platform = isTVApp(ipa) ? "Apple TV" : "iPhone or iPad";
                labels.append(node("h3", ipa.displayName), node("p", [packageVersion(ipa), platform].filter(Boolean).join(" · "), "sr-app-device"));
                identity.append(packageIcon(ipa), labels);
                const mac = requiresMac(ipa);
                const install = button(mac ? "Download IPA" : "Install", trigger =>
                    confirmInstall(ipa, { refresh: refreshApps, library: model.packages, trigger }), "btn btn-primary");
                install.setAttribute("aria-label", `${mac ? "Download" : "Install"} ${ipa.displayName} for ${platform}`);
                if (mac) install.title = "Install with SideRelay for Mac";
                row.append(identity, install);
                return row;
            }));
            if (focused?.isConnected) focused.focus({ preventScroll: true });
        }
        function render() {
            for (const icon of rows.querySelectorAll("[data-package-id]")) iconObserver.unobserve(icon);
            rows.replaceChildren();
            if (tab === "Library") renderLibrary();
        }
        async function importedBuild(result) {
            if (!section.isConnected || result?.cancelled) return;
            if (result?.pending) {
                status.textContent = "Importing Xcode build…";
                return;
            }
            if (result?.error || !result?.id) {
                status.textContent = result?.error || "Could not import the Xcode build.";
                return;
            }
            await refreshLibrary();
            status.textContent = `${result.displayName} saved to the library.`;
            if (tab === "Library") void confirmInstall(result, { refresh: refreshApps, library: model.packages });
        }
        globalThis.sideRelayBuildDrop = importedBuild;
        input.addEventListener("change", async () => {
            const file = input.files[0];
            input.value = "";
            if (!file || add.disabled) return;
            if (!/\.ipa$/i.test(file.name)) {
                status.textContent = "Choose an IPA file.";
                return;
            }
            add.disabled = true;
            status.textContent = "Importing IPA…";
            try {
                const item = await upload("import", file);
                await refreshLibrary();
                status.textContent = `${item.displayName} saved to the library.`;
            } catch (error) {
                status.textContent = readableError(error, "Could not import the IPA.");
            } finally { add.disabled = false; }
        });

        function confirmRemoval(ipa, trigger) {
            const dialog = node("dialog", "", "sr-certificate-review sr-package-dialog");
            const title = node("h2", "Remove from Library?");
            title.id = "sr-remove-ipa-title";
            dialog.setAttribute("aria-labelledby", title.id);
            const name = [ipa.displayName, packageVersion(ipa)].filter(Boolean).join(" ");
            const explanation = node("p", `Remove the saved copy of ${name} from Library.`);
            const result = feedback();
            const actions = node("div", "", "sr-actions");
            const cancel = button("Cancel", () => dialog.close());
            const remove = button("Remove", async control => {
                if (control.disabled) return;
                control.disabled = cancel.disabled = true;
                result.textContent = "Removing…";
                try {
                    await globalThis.sideRelayJobs.requete("remove_library_ipa", { package_id: ipa.id });
                    selection.delete(ipa.id);
                    libraryIcons.delete(ipa.id);
                    ++version;
                    model.packages = model.packages.filter(item => item.id !== ipa.id);
                    render();
                    onLibraryChange();
                    status.textContent = `${name} removed from Library.`;
                    dialog.close();
                } catch (error) {
                    result.textContent = readableError(error, "Could not remove this IPA.");
                    control.disabled = cancel.disabled = false;
                }
            }, "btn btn-secondary sr-library-remove");
            dialog.addEventListener("cancel", event => {
                if (remove.disabled) event.preventDefault();
            });
            dialog.addEventListener("close", () => {
                dialog.remove();
                (trigger.isConnected ? trigger : add).focus({ preventScroll: true });
            }, { once: true });
            actions.append(cancel, remove);
            dialog.append(title, explanation, result, actions);
            document.body.append(dialog);
            dialog.showModal();
            cancel.focus();
        }

        async function openBuildActions(control, ipa, saved, isInstalled) {
            if (menuOpen) return;
            menuOpen = true;
            const bounds = control.getBoundingClientRect();
            try {
                const action = await bridge.postMessage({
                    action: "libraryBuildActions", details: ipa.available ? "1" : "0", remove: ipa.inUse ? "0" : "1",
                    install: ipa.available && isInstalled ? "1" : "0",
                    x: String(bounds.left), y: String(Math.min(bounds.bottom, innerHeight)),
                });
                if (!section.isConnected || tab !== "Library") return;
                const current = model.packages.find(item => item.id === ipa.id);
                if (action === "details" && current?.available) showInspection(current, model.packages, saved);
                if (action === "signImported" && current?.available) {
                    await bridge.postMessage({ action: "signImported", packageId: current.id });
                }
                if (action === "install" && current?.available) {
                    await confirmInstall(current, { refresh: refreshApps, library: model.packages, trigger: control });
                }
                if (action === "remove" && current && !current.inUse) confirmRemoval(current, control);
            } catch (error) {
                status.textContent = readableError(error, "Could not open build actions.");
            } finally { menuOpen = false; }
        }

        function renderLibrary() {
            const groups = new Map();
            for (const ipa of model.packages) {
                const key = ipa.bundleId || ipa.id;
                if (!groups.has(key)) groups.set(key, []);
                groups.get(key).push(ipa);
            }
            const batchActions = node("div", "", "sr-library-batch-actions");
            const review = button("Review Batch…", () => {
                const selected = model.packages.filter(item => selection.has(item.id) && item.available);
                if (selected.length) void batches.review(selected, model.packages, refreshApps);
            });
            function updateSelection() {
                const count = model.packages.filter(item => selection.has(item.id) && item.available).length;
                batchActions.hidden = !count;
                review.textContent = `Review Batch (${count})…`;
            }
            updateSelection();
            batchActions.append(review);
            rows.append(batchActions);
            if (!model.packages.length) rows.append(node("p", loaded ? "No IPA files saved." : "Loading…", "muted"));
            const packages = node("div", "", "sr-library-packages");
            const trackedApps = getInstalledApps().filter(app => !app.liveContainer);
            const activePackages = new Set(trackedApps.map(app => app.packageID));
            const isCurrent = ipa => activePackages.has(ipa.id) || ipa.installations?.some(entry => entry.current);
            function findUpdates(apps, sources, candidates) {
                return apps.flatMap(target => {
                    if (!target.deviceID || !target.accountID) return [];
                    const release = newRelease(target, sources, candidates);
                    return release ? [{ target, release }] : [];
                });
            }
            function packageRow(ipa, isSummary, offers) {
                const row = node("div", "", isSummary ? "sr-library-build sr-library-build-main" : "sr-library-build");
                const labels = node("div");
                const saved = ipa.importedAt ? savedDate.format(ipa.importedAt * 1000) : "";
                const version = packageVersion(ipa) || "Unknown Version";
                const installed = isCurrent(ipa);
                const state = !ipa.available ? "IPA file unavailable"
                    : !installed && ipa.installations?.length ? "Previously installed" : "";
                const buildName = [ipa.displayName, version, saved && `saved ${saved}`].filter(Boolean).join(" ");
                const versionLabel = buildVersion(ipa, version, isSummary);
                labels.append(isSummary ? node("h3", ipa.displayName) : versionLabel);
                const metadata = [!isSummary && saved, state || ipa.sourceName].filter(Boolean);
                if (isSummary || metadata.length) {
                    const footnote = node("p", "", "sr-library-meta");
                    if (isSummary) footnote.append(versionLabel);
                    for (const text of metadata) footnote.append(node("span", text));
                    if (installed && offers.length) footnote.append(node("span", "Installed", "sr-library-installed-label"));
                    labels.append(footnote);
                }
                const choose = node("input");
                choose.type = "checkbox";
                choose.setAttribute("aria-label", `Select ${buildName}`);
                choose.title = "Select for Batch";
                choose.disabled = !ipa.available;
                choose.checked = ipa.available && selection.has(ipa.id);
                choose.addEventListener("change", () => {
                    if (choose.checked) selection.add(ipa.id);
                    else selection.delete(ipa.id);
                    updateSelection();
                });
                row.append(choose);
                if (isSummary) row.append(packageIcon(ipa));
                const actions = node("div", "", "sr-actions sr-library-row-actions");
                if (offers.length) {
                    actions.append(updateControls(offers, isSummary ? "btn btn-primary" : "btn btn-secondary"));
                } else if (installed) {
                    const updated = trackedApps.some(app => app.packageID === ipa.id && updateState(app)?.kind === "success");
                    actions.append(node("span", updated ? "Updated" : "Installed", "sr-install-complete sr-library-installed"));
                } else if (ipa.available) {
                    const mac = globalThis.sideRelayIPAPlatforms.requiresMac(ipa);
                    const install = button(mac ? "Download IPA" : "Install", trigger =>
                        confirmInstall(ipa, { refresh: refreshApps, library: model.packages, trigger }),
                        isSummary ? "btn btn-primary" : "btn btn-secondary");
                    install.setAttribute("aria-label", `${mac ? "Download" : "Install"} ${buildName}`);
                    if (mac) install.title = "Install with SideRelay for Mac";
                    actions.append(install);
                }
                const options = button("", control => openBuildActions(control, ipa, saved, installed), "btn btn-secondary sr-library-options");
                options.setAttribute("aria-label", `More actions for ${buildName}`);
                options.setAttribute("aria-haspopup", "menu");
                options.title = "More Actions";
                actions.append(options);
                row.append(labels, actions);
                return row;
            }
            for (const [key, variants] of groups) {
                const preferred = variants.find(ipa => ipa.available && isCurrent(ipa))
                    || variants.find(isCurrent)
                    || variants.find(ipa => ipa.available) || variants[0];
                const apps = trackedApps.filter(app => originalBundle(app, model.packages) === key || app.bundleID === key);
                const offers = findUpdates(apps, model.sources, model.packages);
                const card = node("article", "", "sr-library-card");
                card.setAttribute("aria-label", preferred.displayName);
                card.append(packageRow(preferred, true, offers));
                const others = variants.filter(ipa => ipa !== preferred);
                if (others.length) {
                    const history = node("details", "", "sr-library-builds");
                    history.open = expandedBuilds.has(key);
                    history.addEventListener("toggle", () => {
                        if (!history.isConnected) return;
                        if (history.open) expandedBuilds.add(key);
                        else expandedBuilds.delete(key);
                    });
                    history.append(node("summary", `Other Builds (${others.length})`));
                    for (const ipa of others) history.append(packageRow(ipa, false, isCurrent(ipa) ? [] : findUpdates(apps, [], [ipa])));
                    card.append(history);
                }
                packages.append(card);
            }
            if (packages.childElementCount) rows.append(packages);
        }
        async function versions(app, trigger) {
            if (document.querySelector(".sr-package-dialog[open]")) return;
            const dialog = node("dialog", "", "sr-certificate-review sr-package-dialog sr-versions-dialog");
            const title = node("h2", `${app.name} Versions`);
            title.id = "sr-package-dialog-title";
            dialog.setAttribute("aria-labelledby", title.id);
            const body = node("div", "", "sr-versions-content");
            const result = feedback();
            const buttons = node("div", "", "sr-actions");
            buttons.append(button("Close", () => dialog.close()));
            dialog.append(title, body, result, buttons);
            dialog.addEventListener("close", () => {
                dialog.remove();
                if (!document.querySelector(".sr-package-dialog[open]") && trigger?.isConnected) trigger.focus();
            }, { once: true });
            document.body.append(dialog);
            dialog.showModal();
            result.textContent = "Loading versions…";
            try {
                const latest = await catalogue("list");
                if (!dialog.open) return;
                const release = newRelease(app, latest.sources, latest.packages);
                if (release) {
                    const row = node("div", "", "sr-source-release");
                    row.append(node("strong", packageVersion(release.release)), updateControls([{ target: app, release }], "btn btn-primary"));
                    body.append(node("h3", "Available Update"), row);
                }
                body.append(node("h3", "Saved Versions"));
                const installedVersions = latest.packages.flatMap(ipa => (ipa.installations || [])
                    .filter(entry => entry.appId === app.id).map(entry => ({ ipa, entry })));
                installedVersions.sort((a, b) => Number(b.entry.current) - Number(a.entry.current) ||
                    b.entry.installedAt - a.entry.installedAt);
                if (!installedVersions.length) body.append(node("p", "No installed versions saved.", "muted"));
                const older = installedVersions.filter(version => !version.entry.current);
                const history = node("details", "", "sr-versions-history");
                if (older.length) history.append(node("summary", `Previous Builds (${older.length})`));
                const dateTime = new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" });
                for (const { ipa, entry } of installedVersions) {
                    const row = node("div", "", "sr-source-release");
                    const label = node("div", [packageVersion(ipa), entry.current ? "Installed" : "Previously installed",
                        entry.installedAt && dateTime.format(entry.installedAt * 1000)].filter(Boolean).join(" · "));
                    row.append(label);
                    if (!entry.current && ipa.available) {
                        row.append(button("Review Restore…", () => {
                            dialog.close();
                            return confirmInstall(ipa, { target: app, refresh: refreshApps, library: latest.packages });
                        }));
                    }
                    (entry.current ? body : history).append(row);
                }
                if (older.length) body.append(history);
                result.textContent = "";
            } catch (error) {
                result.textContent = readableError(error, "Could not load versions.");
            }
        }
        async function checkSources() {
            if (tab === "Store") return false;
            const hour = 3600 * 1000;
            const now = Date.now();
            const stale = model.sources.filter(source =>
                now - source.checkedAt * 1000 >= hour && now - (sourceChecks.get(source.id) || 0) >= hour);
            if (!stale.length) return false;
            let updated = false;
            for (const source of stale) {
                if (!section.isConnected) break;
                sourceChecks.set(source.id, now);
                try {
                    await catalogue("refresh", { sourceId: source.id });
                    updated = true;
                } catch {
                    // Keep the cached catalogue if the publisher is unavailable.
                }
            }
            if (updated && section.isConnected) await refreshLibrary();
            return updated;
        }
        function updateFor(app) {
            return model.updates?.[app.id] || null;
        }
        select("Installed");
        return {
            updateFor, updateInstalled, updateState, updateAppearance, versions, refresh: refreshLibrary, checkSources, watchInbox, renderInbox,
            reviewBatch: (packages, draft) => batches.review(packages, model.packages, refreshApps, draft),
        };
    }

    function mountStore(main) {
        const store = globalThis.sideRelayStore({
            node, button, feedback, catalogue, formatDate, failure: readableError,
            manage: trigger => manageSources(trigger, store.update),
            prepare: prepareStoreInstall,
            review: async (ipa, trigger, targets) => {
                const { packages } = await catalogue("list");
                if (trigger.isConnected) await confirmInstall(ipa, { library: packages, trigger, targets });
            },
        });
        main.prepend(store.view);
        void store.refresh();
    }

    async function prepareStoreInstall({ app, release }, trigger) {
        const { requete } = globalThis.sideRelayJobs;
        const [devices, accounts, deviceVersions] = await Promise.all([
            requete("list_devices"), requete("list_accounts"),
            release.minOS ? bridge.postMessage({ action: "installDeviceVersions" }).catch(() => ({})) : {},
        ]);
        if (!trigger.isConnected) return;
        const tv = release.platform === "tvOS";
        const platform = tv ? "Apple TV" : "iPhone or iPad";
        const build = { platforms: [tv ? "AppleTVOS" : "iPhoneOS"], minimumOs: release.minOS };
        const compatible = compatibleTargets(devices, build, deviceVersions);
        if (accounts.length && compatible.length) return { devices, accounts, deviceVersions };
        const dialog = node("dialog", "", "sr-certificate-review sr-store-install-help");
        const heading = node("h2", `Get ${app.name}`);
        heading.id = "sr-store-install-help-title";
        dialog.setAttribute("aria-labelledby", heading.id);
        const paired = globalThis.sideRelayIPAPlatforms.targetDevices(devices, build).length;
        const problem = !paired ? `Pair an ${platform} to install this app.`
            : !compatible.length ? `This version requires ${tv ? "tvOS" : "iOS or iPadOS"} ${release.minOS} or later. Update the device or choose another one.`
            : "Connect an Apple Account to sign this app.";
        const actions = node("div", "", "sr-actions");
        const action = node("a", compatible.length ? "Open Apple Accounts" : "Open Devices", "btn btn-primary");
        action.href = compatible.length ? "/accounts" : "/devices";
        actions.append(button("Cancel", () => dialog.close()), action);
        dialog.append(heading, node("p", problem), actions);
        dialog.addEventListener("close", () => { dialog.remove(); if (trigger.isConnected) trigger.focus(); }, { once: true });
        document.body.append(dialog);
        dialog.showModal();
    }

    async function manageSources(trigger, update) {
        const dialog = node("dialog", "", "sr-certificate-review sr-store-sources");
        const title = node("h2", "Manage Sources");
        title.id = "sr-store-sources-title";
        dialog.setAttribute("aria-labelledby", title.id);
        const message = feedback();
        const items = node("div", "", "sr-store-source-list");
        const form = node("form", "", "sr-source-form");
        const label = node("label", "Catalogue URL", "form-field");
        const url = node("input");
        url.type = "url";
        url.required = true;
        url.placeholder = "https://…/apps.json";
        label.append(url);
        const add = node("button", "Add Source", "btn btn-primary");
        add.type = "submit";
        form.append(label, add);
        let busy = false;
        let sources = [];
        async function run(operation, args, pending, done) {
            if (busy || !dialog.open) return;
            busy = true;
            const controls = [...dialog.querySelectorAll("button:not(.sr-store-done)")];
            controls.forEach(control => control.disabled = true);
            message.textContent = pending;
            try {
                const result = await catalogue(operation, args);
                sources = result.sources;
                update(sources);
                message.textContent = result.failed?.length ? "Some sources couldn’t load." : done;
                list();
                return true;
            } catch (error) {
                message.textContent = readableError(error, "Could not update the source.");
                return false;
            } finally {
                busy = false;
                controls.forEach(control => control.disabled = false);
            }
        }
        form.addEventListener("submit", async event => {
            event.preventDefault();
            if (!event.isTrusted) return;
            if (await run("add", { url: url.value.trim() }, "Reading catalogue…", "Source added.")) url.value = "";
        });
        function list() {
            items.replaceChildren();
            if (!sources.length) items.append(node("p", "No sources added.", "muted"));
            for (const source of sources) {
                const row = node("div", "", "sr-store-source");
                const identity = node("div");
                const detail = source.checkedAt ?
                    (source.apps.length === 1 ? "1 app" : source.apps.length + " apps") + " · " + formatDate(source.checkedAt)
                    : "Pending download";
                identity.append(node("strong", source.name), node("p", detail, "muted"));
                const refresh = button("Refresh", () => run("refresh", { sourceId: source.id }, "Checking for updates…", "Source refreshed."));
                refresh.setAttribute("aria-label", "Refresh " + source.name);
                const remove = button("Remove", () => run("remove", { sourceId: source.id }, "Removing source…", "Source removed."), "sr-link");
                remove.setAttribute("aria-label", "Remove " + source.name);
                row.append(identity, refresh, remove);
                items.append(row);
            }
        }
        const actions = node("footer", "", "sr-actions sr-store-source-actions");
        actions.append(button("Refresh All", () => run("refresh-store", { force: "yes" }, "Refreshing sources…", "Sources refreshed.")),
            button("Done", () => dialog.close(), "btn btn-primary sr-store-done"));
        dialog.append(title, form, message, items, actions);
        dialog.addEventListener("close", () => {
            dialog.remove();
            if (trigger?.isConnected) trigger.focus();
        }, { once: true });
        document.body.append(dialog);
        dialog.showModal();
        await run("store", {}, "Loading sources…", "");
    }
    function profiles(app, trigger) {
        const dialog = node("dialog", "", "sr-pair-dialog sr-profile-dialog");
        const title = node("h2", `${app.name || app.bundleID} · Provisioning Profiles`);
        title.id = "sr-app-profiles-title";
        dialog.setAttribute("aria-labelledby", title.id);
        const details = node("dl", "", "sr-profile-metadata");
        labelled(details, "Bundle ID", app.bundleID);
        labelled(details, "Last Refreshed", formatDate(app.refreshedAt));
        const items = app.profileDetails || [];
        const list = node("ul", "", "sr-profile-records");
        for (const item of items) {
            const main = item.bundleId === app.bundleID;
            const row = node("li");
            const identity = node("div");
            identity.append(node("strong", main ? "Main App" : "Extension"));
            if (!main) identity.append(node("small", item.bundleId, "muted"));
            const expiry = formatDate(item.expiresAt);
            row.append(identity, node("span", expiry ? `Expires ${expiry}` : "Unknown expiry", "muted"));
            list.append(row);
        }
        const footer = node("div", "", "sr-actions");
        const done = button("Done", () => dialog.close(), "btn btn-primary");
        done.autofocus = true;
        footer.append(done);
        dialog.append(title, details);
        if (app.useMainProfile) dialog.append(node("p", "Extensions share the main app’s profile.", "muted"));
        dialog.append(items.length ? list
            : node("p", "Profile dates are available after the next successful refresh.", "muted"), footer);
        dialog.addEventListener("close", () => {
            dialog.remove();
            if (trigger.isConnected) trigger.focus({ preventScroll: true });
        }, { once: true });
        document.body.append(dialog);
        dialog.showModal();
    }

    function certificateDetails(certificate, trigger) {
        const dialog = node("dialog", "", "sr-pair-dialog sr-certificate-detail-sheet");
        const title = node("h2", certificate.name);
        title.id = "sr-signing-certificate-title";
        dialog.setAttribute("aria-labelledby", title.id);

        const properties = node("dl", "", "sr-certificate-properties");
        for (const [label, value] of [
            ["Status", certificate.used ? "Used by SideRelay" : certificate.state],
            ["Expires", formatDate(certificate.expiresAt) || "Unknown"],
            ["Serial Number", node("code", certificate.serial)],
        ]) {
            const row = node("div");
            const detail = node("dd");
            detail.append(value);
            row.append(node("dt", label), detail);
            properties.append(row);
        }

        const apps = node("section", "", "sr-certificate-linked-apps");
        apps.append(node("h3", "Linked Apps"));
        if (certificate.apps.length) {
            const list = node("ul");
            for (const app of certificate.apps) {
                const item = node("li");
                item.append(node("strong", app.name), node("span", app.device, "muted"));
                list.append(item);
            }
            apps.append(list);
        } else {
            apps.append(node("p", "No apps linked in SideRelay.", "muted"));
        }
        const actions = node("div", "", "sr-actions");
        const done = button("Done", () => dialog.close(), "btn btn-primary");
        done.autofocus = true;
        actions.append(done);
        dialog.append(title, properties, apps, actions);
        dialog.addEventListener("close", () => {
            dialog.remove();
            if (trigger.isConnected) trigger.focus({ preventScroll: true });
        }, { once: true });
        document.body.append(dialog);
        dialog.showModal();
    }

    function accountCertificates(main) {
        if (main.querySelector(".sr-account-certificates")) return;
        const section = node("section", "", "sr-app-item sr-account-certificates");
        const heading = node("h2", "Signing Certificates", "sr-app-group-title");
        const content = node("div", "", "sr-certificate-status");
        const status = feedback();
        section.append(heading, content, status);
        main.append(section);

        const { requete } = globalThis.sideRelayJobs;

        function accountRow(account) {
            const group = node("section", "", "sr-certificate-account");
            const header = node("div", "", "sr-certificate-account-header");
            const state = feedback();
            const results = node("ul", "", "sr-signing-certificate-list");
            results.setAttribute("aria-label", `Signing certificates for ${account.apple_id}`);
            let busy = false;

            function certificateRow(certificate) {
                const item = node("li", "", "sr-signing-certificate");
                const details = button("", control => certificateDetails(certificate, control), "btn sr-certificate-row-button");
                details.setAttribute("aria-haspopup", "dialog");
                const icon = node("span", "", "sr-certificate-symbol");
                icon.setAttribute("aria-hidden", "true");
                const identity = node("span", "", "sr-certificate-identity");
                const name = node("strong", certificate.name);
                const label = node("span", certificate.used ? "Used by SideRelay" : certificate.state,
                    certificate.used ? "sr-certificate-current" : "muted");
                identity.append(name, label);
                details.append(icon, identity);
                const expiry = formatDate(certificate.expiresAt);
                if (expiry) details.append(node("span", `Expires ${expiry}`, "muted sr-certificate-expiry"));
                const menu = button("…", async control => {
                    if (busy || control.dataset.menuOpen) return;
                    const bounds = control.getBoundingClientRect();
                    control.dataset.menuOpen = "true";
                    const canRevoke = !refresh.disabled && certificate.state === "Listed by Apple" &&
                        /^[0-9a-f]{1,80}$/i.test(certificate.serial);
                    try {
                        const action = await bridge.postMessage({ action: "certificateActions",
                            x: String(bounds.left), y: String(Math.min(bounds.bottom, window.innerHeight)),
                            revoke: canRevoke ? "1" : "0" });
                        if (!control.isConnected || busy) return;
                        if (action === "details") certificateDetails(certificate, control);
                        if (action === "revoke" && canRevoke) await revoke(certificate);
                    } catch (error) {
                        state.textContent = readableError(error, "Could not open certificate actions.");
                    } finally { delete control.dataset.menuOpen; }
                }, "btn sr-certificate-menu");
                menu.setAttribute("aria-label", `Actions for ${certificate.name}`);
                menu.setAttribute("aria-haspopup", "menu");
                item.append(details, menu);
                return item;
            }

            async function revoke(certificate) {
                busy = true;
                refresh.disabled = true;
                state.textContent = "Checking certificate impact with Apple…";
                try {
                    const result = await bridge.postMessage({ action: "revokeCertificate",
                        accountID: account.id, serial: certificate.serial });
                    if (result.error) throw new Error(result.error);
                    if (result.cancelled) { state.textContent = ""; return; }
                    await readCertificates();
                    state.textContent = result.queued_repairs
                        ? `Certificate revoked. Re-signing queued for ${result.queued_repairs} app(s).`
                        : "Certificate revoked.";
                } catch (error) {
                    state.textContent = readableError(error, "Could not revoke the certificate.");
                } finally { busy = refresh.disabled = false; }
            }

            async function readCertificates() {
                refresh.disabled = true;
                results.setAttribute("aria-busy", "true");
                state.textContent = "Checking certificates with Apple…";
                try {
                    const certificates = await requete("account_signing_status",
                        { account_id: account.id }, AbortSignal.timeout(45000));
                    if (!group.isConnected) return;
                    const ordered = [...certificates].sort((a, b) => Number(b.used) - Number(a.used) ||
                        a.name.localeCompare(b.name));
                    results.replaceChildren(...ordered.map(certificateRow));
                    state.textContent = certificates.some(certificate => certificate.used) ? "" :
                        certificates.length ? "SideRelay has no reusable certificate for this account." :
                        "Apple did not list any development certificates.";
                } catch (error) {
                    state.textContent = message(error, "Could not check certificates with Apple.");
                } finally {
                    results.removeAttribute("aria-busy");
                    refresh.disabled = busy;
                }
            }

            const refresh = button("Refresh", readCertificates);
            refresh.setAttribute("aria-label", `Refresh signing certificates for ${account.apple_id}`);
            header.append(node("h3", account.apple_id), refresh);
            group.append(header, state, results);
            content.append(group);
            void readCertificates();
        }

        void (async () => {
            status.textContent = "Loading Apple Accounts…";
            try {
                const accounts = await requete("list_accounts");
                if (!section.isConnected) return;
                status.textContent = accounts.length ? "" : "Add an Apple Account to see its certificates.";
                for (const account of accounts) accountRow(account);
            } catch {
                status.textContent = "Could not load Apple Accounts.";
            }
        })();
    }

    globalThis.sideRelayCatalogue = {
        mount, mountStore, upload, packageDetails, packageVersion, comparison, installedApps, installedVersion, readableError, profiles, accountCertificates,
    };
})();
