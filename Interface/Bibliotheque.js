(() => {
    if (location.origin !== "http://127.0.0.1:18784") return;
    const bridge = window.webkit.messageHandlers.signatureCompte;
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
        return ipa.build && ipa.build !== ipa.version ? `${ipa.version} (${ipa.build})` : ipa.version;
    }
    function packageDetails(ipa, showIdentity = true) {
        const box = node("div", "", "sr-package-detail");
        const list = node("dl", "", "sr-app-details");
        if (showIdentity) {
            labelled(list, "App", ipa.displayName);
            labelled(list, "Version", packageVersion(ipa));
        }
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
        status.textContent = "Checking the signature in this IPA…";
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
            status.textContent = "Checking the signature in this IPA…";
            try {
                const report = await catalogue("diagnose", { packageId: ipa.id, deviceId });
                if (!dialog.open || request !== check) return;
                const issues = report.components.some(component => component.errors.length);
                status.textContent = issues ? "This IPA has provisioning issues." : report.ready
                    ? "Profile checks passed for this device."
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

    function showInspection(ipa, library) {
        if (document.querySelector(".sr-package-dialog[open]")) return;
        const dialog = node("dialog", "", "sr-certificate-review sr-package-dialog sr-inspection");
        const title = node("h2", "IPA Contents");
        title.id = "sr-inspection-title";
        dialog.setAttribute("aria-labelledby", title.id);
        const name = node("p", [ipa.displayName, packageVersion(ipa), ipa.bundleId].filter(Boolean).join(" · "), "muted");
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
        actions.append(sign, button("Close", () => dialog.close()));
        dialog.append(title, name, profileCheck, status, body, actions);
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
            return { text: `Updates ${match.name}${match.version ? " " + match.version : ""} on this device.`, target: match };
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

    async function confirmInstall(ipa, { target, refresh, library = [], trigger } = {}) {
        if (document.querySelector(".sr-package-dialog[open]")) return;
        const dialog = node("dialog", "", "sr-certificate-review sr-package-dialog");
        const title = node("h2", "Review Installation");
        title.id = "sr-package-dialog-title";
        dialog.setAttribute("aria-labelledby", title.id);
        const fields = node("div", "", "sr-package-targets");
        const status = feedback();
        const close = button("Cancel", () => dialog.close());
        const actions = node("div", "", "sr-actions");
        const installed = node("span", "", "sr-install-complete");
        installed.setAttribute("role", "status");
        actions.append(close, installed);
        const ids = node("section", "", "sr-app-id-preview");
        const idsTitle = node("h3", "App IDs");
        const idsList = node("ul", "", "sr-app-id-list");
        const profile = globalThis.sideRelayProfileChoice({ statusChanged: () => redrawIDs?.() });
        const idsStatus = profile.quota;
        let redrawIDs;
        ids.append(idsTitle, profile.bloc, idsList);
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
        native.append(fields, ids, status, actions);
        dialog.append(title, packageDetails(ipa));
        let mode;
        let checkCurrentIDs;
        if (!target) {
            const { destinationIPA, transfertLiveContainer } = globalThis.sideRelayIPADestination;
            const destination = destinationIPA();
            mode = destination.select;
            const transfert = transfertLiveContainer({
                paquet: () => ipa, format: () => ipa,
                actif: sending => { mode.disabled = sending; },
            });
            const cancel = button("Cancel", () => dialog.close());
            transfert.bloc.append(cancel);
            mode.addEventListener("change", () => {
                const live = mode.value === "livecontainer";
                native.hidden = live;
                transfert.bloc.hidden = !live;
                if (live) { void profile.check(null); transfert.actualiser(); }
                else void checkCurrentIDs?.();
            });
            dialog.append(destination.label, transfert.bloc);
        }
        dialog.append(native);
        dialog.addEventListener("close", () => {
            dialog.remove();
            if (trigger?.isConnected) trigger.focus();
        }, { once: true });
        document.body.append(dialog);
        dialog.showModal();
        status.textContent = "Loading devices and accounts…";
        const { requete, suivreJob } = globalThis.sideRelayJobs;
        try {
            const [devices, accounts, apps] = await Promise.all([
                requete("list_devices"), requete("list_accounts"), installedApps(),
            ]);
            if (!dialog.open) return;
            const device = selectField("iPhone", devices, "name");
            const account = selectField("Apple Account", accounts, "apple_id");
            if (target) {
                device.select.value = target.deviceID;
                account.select.value = target.accountID || "";
                device.select.disabled = account.select.disabled = true;
            }
            fields.append(device.label, account.label);
            let installing = false;
            let lastTarget;
            const activity = node("a", "Open Activity", "sr-link");
            activity.href = "/queue";
            activity.hidden = true;
            actions.prepend(activity);
            const install = button("Install", async control => {
                const result = compare();
                if (installing || result.blocked || profile.blocked || profile.pending || !device.select.value || !account.select.value) return;
                const useMain = profile.selected;
                installing = true;
                profile.enabled = false;
                control.disabled = true;
                if (mode) mode.disabled = true;
                device.select.disabled = account.select.disabled = true;
                close.textContent = "Close";
                status.classList.remove("sr-app-issue");
                status.textContent = "Queuing installation…";
                activity.hidden = true;
                let submitted = false;
                let retryable = false;
                try {
                    const id = await requete("install_library_ipa", {
                        package_id: ipa.id,
                        device_id: device.select.value,
                        account_id: account.select.value,
                        target_app_id: result.target?.id || "",
                        use_main_profile: String(useMain),
                    }, AbortSignal.timeout(120000));
                    if (typeof id !== "string" || !id) throw new Error("Invalid installation response.");
                    submitted = true;
                    status.textContent = "Installation queued.";
                    const job = await suivreJob(id, () => dialog.open, item => {
                        status.textContent = item.status === "running" ? "Installing…" : "Installation queued.";
                    });
                    if (dialog.open) {
                        const cancelled = ["cancelled", "canceled"].includes(job?.status);
                        if (job?.status === "done") {
                            status.textContent = "";
                            status.hidden = true;
                            control.hidden = true;
                            installed.textContent = "Installed";
                            if (document.activeElement === control || !dialog.contains(document.activeElement)) {
                                close.focus({ preventScroll: true });
                            }
                        } else {
                            status.textContent = cancelled ? "Installation was cancelled." :
                                job?.status === "failed" ? message({ message: job.error }, "Installation failed.") :
                                "Installation is still in progress.";
                        }
                        retryable = job?.status === "failed" || cancelled;
                        if (retryable && globalThis.sideRelayJobs.typeErreur(job.error) === "main-profile-verification") {
                            profile.enabled = true;
                            profile.input.focus();
                        }
                        activity.hidden = job?.status === "done";
                    }
                    void refresh?.();
                } catch (error) {
                    const rejected = !submitted && error.http >= 400 && error.http < 500;
                    retryable = rejected;
                    status.textContent = message(error, rejected ? "Could not queue the installation. Check the selection and try again."
                        : "Could not confirm the installation. Check Activity before retrying.");
                    activity.hidden = rejected;
                } finally {
                    if (dialog.open && retryable) {
                        installing = false;
                        profile.enabled = true;
                        if (mode) mode.disabled = false;
                        device.select.disabled = account.select.disabled = Boolean(target);
                        close.textContent = "Cancel";
                        update(true);
                    }
                }
            }, "btn btn-primary");
            function compare() {
                return comparison(ipa, apps, device.select.value, account.select.value, target, library);
            }
            function update(keepStatus = false) {
                const result = compare();
                if (!keepStatus && !installing) status.textContent = result.text || (devices.length && accounts.length
                    ? "Select an iPhone and Apple Account." : "Add an iPhone and Apple Account to install.");
                status.classList.toggle("sr-app-issue", Boolean(result.warning || result.blocked));
                install.disabled = installing || profile.pending || profile.blocked || !device.select.value || !account.select.value || Boolean(result.blocked);
            }
            async function checkIDs() {
                if (mode?.value === "livecontainer") return;
                const current = compare().target;
                if ((current?.id ?? null) !== lastTarget) {
                    lastTarget = current?.id ?? null;
                    profile.input.checked = Boolean(current?.useMainProfile);
                }
                update();
                await profile.check(ipa, account.select.value);
            }
            redrawIDs = () => {
                if (!dialog.open) return;
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
            actions.insertBefore(install, installed);
            checkCurrentIDs = checkIDs;
            void checkIDs();
        } catch {
            status.textContent = "Could not load devices or Apple Accounts.";
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
    function newRelease(app, sources, packages) {
        if (!app.installedAt || !app.version) return null;
        const bundle = originalBundle(app, packages);
        const installedBuild = app.packageMetadata?.build || packages.find(item => item.id === app.packageID)?.build;
        const newer = [];
        for (const source of sources) {
            const item = source.apps.find(entry => entry.bundleId === bundle);
            for (const release of item?.versions || []) {
                const comparison = versionCompare(release.version, app.version);
                if (comparison > 0 || (release.version === app.version && versionCompare(release.build, installedBuild) > 0)) {
                    newer.push({ source, item, release });
                }
            }
        }
        return newer.sort((a, b) => versionCompare(b.release.version, a.release.version) ||
            versionCompare(b.release.build, a.release.build))[0] || null;
    }

    function mount(section, installed, refreshApps, canRefreshApps) {
        let model = { packages: [], sources: [] };
        let loaded = false;
        let tab = "Installed";
        let version = 0;
        const selection = new Set();
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
        const batches = globalThis.sideRelayBatchController({
            node, button, feedback, selectField, comparison, packageDetails, packageVersion, installedApps,
        });
        const toolbar = node("div", "", "sr-catalogue-toolbar");
        const navigation = node("div", "", "sr-catalogue-tabs");
        navigation.setAttribute("role", "group");
        navigation.setAttribute("aria-label", "Apps view");
        const input = node("input");
        input.type = "file";
        input.accept = ".ipa";
        input.hidden = true;
        const add = button("Import IPA…", () => input.click(), "btn btn-primary");
        const more = button("More", openActions, "btn btn-secondary sr-catalogue-more");
        more.setAttribute("aria-label", "More app actions");
        more.setAttribute("aria-haspopup", "menu");
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
        section.prepend(toolbar, status);
        section.append(content);

        function select(name) {
            tab = name;
            if (tab !== "Library") iconObserver.disconnect();
            void bridge.postMessage({ action: "libraryDropEnabled", enabled: tab === "Library" ? "yes" : "no" }).catch(() => {});
            add.hidden = tab !== "Library";
            installed.hidden = tab !== "Installed";
            content.hidden = tab === "Installed";
            status.textContent = "";
            for (const [key, control] of tabs) control.setAttribute("aria-pressed", String(tab === key));
            if (tab === "Library") {
                render();
                if (!loaded) void refreshLibrary();
            }
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
                if (tab === "Library") render();
            } catch (error) {
                if (tab !== "Installed" && request === version) {
                    status.textContent = readableError(error, "Could not load the library or sources.");
                }
            }
        }
        function render() {
            iconObserver.disconnect();
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
            function packageRow(ipa, multiple) {
                const row = node("article", "", "sr-app-item");
                const title = node("div", "", "sr-library-heading");
                const labels = node("div");
                const saved = multiple && ipa.importedAt ? new Intl.DateTimeFormat("en", { dateStyle: "medium", timeStyle: "short" }).format(ipa.importedAt * 1000) : "";
                labels.append(node("h3", ipa.displayName),
                    node("p", [packageVersion(ipa), ipa.sourceName, ipa.installations?.some(item => item.current)
                        ? "Installed" : ipa.installations?.length ? "Previously installed" : ""].filter(Boolean).join(" · "), "muted"));
                if (saved) labels.append(node("p", `Saved ${saved}`, "muted sr-library-date"));
                const entry = node("div", "", "sr-library-entry");
                const choose = node("input");
                choose.type = "checkbox";
                choose.setAttribute("aria-label", ["Select", ipa.displayName, packageVersion(ipa), saved && `saved ${saved}`].filter(Boolean).join(" "));
                choose.disabled = !ipa.available;
                choose.checked = ipa.available && selection.has(ipa.id);
                choose.addEventListener("change", () => {
                    if (choose.checked) selection.add(ipa.id);
                    else selection.delete(ipa.id);
                    updateSelection();
                });
                const icon = node("span", "", "sr-library-icon");
                icon.setAttribute("aria-hidden", "true");
                icon.append(node("span"));
                if (ipa.available) {
                    icon.dataset.packageId = ipa.id;
                    iconObserver.observe(icon);
                }
                entry.append(choose, icon, labels);
                title.append(entry);
                if (ipa.available) {
                    const install = button("Install",
                        () => confirmInstall(ipa, { refresh: refreshApps, library: model.packages }), "btn btn-primary sr-library-install");
                    install.setAttribute("aria-label", ["Install", ipa.displayName, packageVersion(ipa), saved && `saved ${saved}`].filter(Boolean).join(" "));
                    title.append(install);
                }
                row.append(title);
                if (!ipa.available) row.append(node("p", "IPA file unavailable.", "sr-app-issue"));
                else {
                    const details = node("details", "", "sr-library-detail");
                    details.append(node("summary", "IPA Details"), packageDetails(ipa, false),
                        button("Inspect Contents…", () => showInspection(ipa, model.packages), "sr-link sr-library-action"));
                    row.append(details);
                }
                return row;
            }
            for (const variants of groups.values()) {
                const preferred = variants.find(ipa => ipa.available && ipa.installations?.some(item => item.current))
                    || variants.find(ipa => ipa.available) || variants[0];
                packages.append(packageRow(preferred, variants.length > 1));
                const others = variants.filter(ipa => ipa !== preferred);
                if (others.length) {
                    const history = node("details", "", "sr-library-builds");
                    history.open = others.some(ipa => selection.has(ipa.id));
                    history.append(node("summary", `Other builds of ${preferred.displayName} (${others.length})`));
                    for (const ipa of others) history.append(packageRow(ipa, true));
                    packages.append(history);
                }
            }
            if (packages.childElementCount) rows.append(packages);
        }
        function releaseRow(source, item, release, target, localStatus = status) {
            const row = node("div", "", "sr-source-release");
            const labels = node("div");
            labels.append(node("strong", packageVersion(release)), node("p",
                [formatDate(release.date), release.minOS ? "Minimum iOS " + release.minOS : "",
                 release.maxOS ? "Maximum iOS " + release.maxOS : ""].filter(Boolean).join(" · "), "muted"));
            if (release.notes) labels.append(node("p", release.notes, "sr-release-notes"));
            const download = button(target ? "Download & Review…" : "Download", async control => {
                control.disabled = true;
                localStatus.textContent = "Downloading IPA…";
                try {
                    const ipa = await catalogue("download", { sourceId: source.id, bundleId: item.bundleId, versionId: release.id });
                    await refreshLibrary();
                    localStatus.textContent = `${ipa.displayName} saved to the library.`;
                    if (target && localStatus.closest("dialog")?.open) {
                        localStatus.closest("dialog").close();
                        await confirmInstall(ipa, { target, refresh: refreshApps, library: model.packages });
                    }
                } catch (error) {
                    localStatus.textContent = readableError(error, "Could not download the IPA.");
                } finally { control.disabled = false; }
            });
            row.append(labels, download);
            return row;
        }
        async function versions(app) {
            if (document.querySelector(".sr-package-dialog[open]")) return;
            const dialog = node("dialog", "", "sr-certificate-review sr-package-dialog");
            const title = node("h2", `${app.name} Versions`);
            title.id = "sr-package-dialog-title";
            dialog.setAttribute("aria-labelledby", title.id);
            const body = node("div");
            const result = feedback();
            const buttons = node("div", "", "sr-actions");
            buttons.append(button("Close", () => dialog.close()));
            dialog.append(title, body, result, buttons);
            dialog.addEventListener("close", () => dialog.remove(), { once: true });
            document.body.append(dialog);
            dialog.showModal();
            result.textContent = "Loading versions…";
            try {
                const latest = await catalogue("list");
                if (!dialog.open) return;
                const release = newRelease(app, latest.sources, latest.packages);
                if (release) {
                    body.append(node("h3", "Available Update"),
                        releaseRow(release.source, release.item, release.release, app, result));
                }
                body.append(node("h3", "Saved Versions"));
                const installedVersions = latest.packages.flatMap(ipa => (ipa.installations || [])
                    .filter(entry => entry.appId === app.id).map(entry => ({ ipa, entry })));
                installedVersions.sort((a, b) => Number(b.entry.current) - Number(a.entry.current) ||
                    b.entry.installedAt - a.entry.installedAt);
                if (!installedVersions.length) body.append(node("p", "No installed versions saved.", "muted"));
                for (const { ipa, entry } of installedVersions) {
                    const row = node("div", "", "sr-source-release");
                    const label = node("div", [packageVersion(ipa), entry.current ? "Installed" : "Previously installed",
                        formatDate(entry.installedAt)].filter(Boolean).join(" · "));
                    row.append(label);
                    if (!entry.current && ipa.available) {
                        row.append(button("Review Restore…", () => {
                            dialog.close();
                            return confirmInstall(ipa, { target: app, refresh: refreshApps, library: latest.packages });
                        }));
                    }
                    body.append(row);
                }
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
        function decorate(container, apps) {
            for (const app of apps.filter(item => item.installedAt)) {
                const card = container.querySelector(`[data-sr-app-id="${CSS.escape(app.id)}"]`);
                if (!card) continue;
                card.querySelector(".sr-version-action")?.remove();
                const release = newRelease(app, model.sources, model.packages);
                const title = release ? `Update Available · ${release.release.version}` : "Versions…";
                const action = button(title, () => versions(app), "btn btn-secondary sr-version-action");
                card.querySelector(".sr-app-controls")?.prepend(action);
            }
        }
        select("Installed");
        return {
            decorate, refresh: refreshLibrary, checkSources,
            reviewBatch: (packages, draft) => batches.review(packages, model.packages, refreshApps, draft),
        };
    }

    function mountStore(main) {
        const store = globalThis.sideRelayStore({
            node, button, feedback, catalogue, formatDate, failure: readableError,
            manage: trigger => manageSources(trigger, store.update),
            review: async (ipa, trigger) => {
                const { packages } = await catalogue("list");
                if (trigger.isConnected) await confirmInstall(ipa, { library: packages, trigger });
            },
        });
        main.prepend(store.view);
        void store.refresh();
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
    function profiles(app) {
        const section = node("details", "", "sr-app-profiles");
        section.append(node("summary", "Provisioning Profiles"));
        if (app.useMainProfile) section.append(node("p", "Extensions share the main app’s profile.", "muted"));
        const list = node("dl", "", "sr-app-details");
        const items = app.profileDetails?.length ? app.profileDetails : [];
        for (const item of items) {
            const row = node("div");
            const label = node("dt", item.bundleId === app.bundleID ? "App" : "Extension");
            label.append(node("small", item.bundleId));
            row.append(label, node("dd", formatDate(item.expiresAt) || "Unknown expiry"));
            list.append(row);
        }
        if (items.length) section.append(list);
        else section.append(node("p", "Individual dates are available after the next successful refresh.", "muted"));
        return section;
    }

    function accountCertificates(main) {
        if (main.querySelector(".sr-account-certificates")) return;
        const section = node("details", "", "sr-app-item sr-account-certificates");
        const summary = node("summary", "Signing Certificates");
        const content = node("div", "", "sr-certificate-status");
        const status = feedback();
        section.append(summary, content, status);
        main.append(section);
        section.addEventListener("toggle", async () => {
            if (!section.open || content.hasChildNodes()) return;
            status.textContent = "Loading Apple Accounts…";
            const { requete } = globalThis.sideRelayJobs;
            try {
                const accounts = await requete("list_accounts");
                if (!section.isConnected) return;
                if (!accounts.length) {
                    status.textContent = "Add an Apple Account to see its certificates.";
                    return;
                }
                status.textContent = "";
                for (const account of accounts) {
                    const row = node("section", "", "sr-account-status-row");
                    const title = node("div", "", "sr-library-heading");
                    title.append(node("h3", account.apple_id));
                    const results = node("div");
                    const state = feedback();
                    async function readCertificates() {
                        check.disabled = true;
                        state.textContent = "Checking certificates with Apple…";
                        try {
                            const certificates = await requete("account_signing_status",
                                { account_id: account.id }, AbortSignal.timeout(45000));
                            results.replaceChildren();
                            state.textContent = certificates.some(certificate => certificate.used) ? "" :
                                certificates.length ? "SideRelay has no reusable certificate for this account." :
                                "Apple did not list any development certificates.";
                            for (const certificate of certificates) {
                                const block = node("div", "", "sr-certificate-info");
                                const heading = node("div", "", "sr-library-heading");
                                heading.append(node("strong", certificate.name));
                                if (certificate.state === "Listed by Apple" && /^[0-9a-f]{1,80}$/i.test(certificate.serial)) {
                                    heading.append(button("Revoke…", async control => {
                                        control.disabled = true;
                                        state.textContent = "Reviewing the certificate with Apple…";
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
                                        } finally { control.disabled = false; }
                                    }, "sr-link sr-app-delete"));
                                }
                                block.append(heading);
                                const details = node("dl", "", "sr-app-details");
                                labelled(details, "Status", certificate.used ? "Used by SideRelay" : certificate.state);
                                labelled(details, "Expires", formatDate(certificate.expiresAt) || "Unknown");
                                labelled(details, "Serial", certificate.serial);
                                block.append(details);
                                if (certificate.apps.length) {
                                    const list = node("ul");
                                    for (const app of certificate.apps) list.append(node("li", `${app.name} · ${app.device}`));
                                    block.append(list);
                                } else {
                                    block.append(node("p", "No installed apps linked in SideRelay.", "muted"));
                                }
                                results.append(block);
                            }
                        } catch (error) {
                            state.textContent = message(error, "Could not check certificates with Apple.");
                        } finally { check.disabled = false; }
                    }
                    const check = button("Check Status", readCertificates);
                    title.append(check);
                    row.append(title, state, results);
                    content.append(row);
                }
            } catch {
                status.textContent = "Could not load Apple Accounts.";
            }
        });
    }

    globalThis.sideRelayCatalogue = {
        mount, mountStore, upload, packageDetails, comparison, installedApps, readableError, profiles, accountCertificates,
    };
})();
