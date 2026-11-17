(() => {
    const root = document.documentElement;
    root.toggleAttribute("data-sr-web", true);

    function node(tag, text = "", css = "") {
        const element = document.createElement(tag);
        element.textContent = text;
        element.className = css;
        return element;
    }

    function button(text, action, primary = false) {
        const control = node("button", text, `btn ${primary ? "btn-primary" : "btn-secondary"}`);
        control.type = "button";
        control.addEventListener("click", action);
        return control;
    }

    async function post(path, data, extra = {}, binary = false) {
        const response = await fetch(`/_siderelay/${path}`, {
            method: "POST", redirect: "error",
            headers: { "X-SideRelay-Web": "1", "Content-Type": binary ? "application/octet-stream" : "application/json", ...extra },
            body: binary ? data : JSON.stringify(data),
        });
        if (!response.ok) {
            const failure = await response.json().catch(() => ({}));
            throw new Error(failure.error || "SideRelay could not complete this request.");
        }
        return response;
    }

    async function request(data) { return (await post("bridge", data)).json(); }

    const alertsPreference = "siderelay.expiry-notifications";
    const alertsShown = "siderelay.expiry-notifications-shown";
    const expiryNotificationsAvailable = "Notification" in window;
    let checkingExpiry = false;
    async function expiryAlerts() {
        if (!expiryNotificationsAvailable || localStorage.getItem(alertsPreference) !== "yes"
            || Notification.permission !== "granted" || checkingExpiry) return;
        checkingExpiry = true;
        try {
            const alerts = await request({ action: "expiryAlerts" });
            const previous = JSON.parse(localStorage.getItem(alertsShown) || "{}");
            const newAlerts = Object.entries(alerts).filter(([id, expiry]) => previous[id] !== expiry).length;
            if (newAlerts) {
                const body = newAlerts === 1 ? "An app needs a refresh." : `${newAlerts} apps need a refresh.`;
                const notification = new Notification("SideRelay", { body, tag: "siderelay-expiry", icon: "/favicon.ico" });
                notification.onclick = () => {
                    window.focus();
                    location.assign("/?view=apps");
                };
            }
            localStorage.setItem(alertsShown, JSON.stringify(alerts));
        } catch {
            // Retry when the portal is available again.
        } finally {
            checkingExpiry = false;
        }
    }

    function postFiles(path, data, files, relativePaths) {
        const manifest = new TextEncoder().encode(JSON.stringify({ ...data, files: files.map((file, index) => ({
            name: relativePaths?.[index] || file.webkitRelativePath || file.name, size: file.size,
        })) }));
        const size = new DataView(new ArrayBuffer(4));
        size.setUint32(0, manifest.length);
        return post(path, new Blob([size.buffer, manifest, ...files]), {}, true);
    }

    function save(blob, filename) {
        const url = URL.createObjectURL(blob);
        const link = node("a");
        link.href = url;
        link.download = filename;
        link.click();
        setTimeout(() => URL.revokeObjectURL(url), 30000);
    }

    function downloadIPA(id) {
        const link = node("a");
        link.href = `/_siderelay/ipa/${encodeURIComponent(id)}`;
        link.download = "";
        link.click();
    }

    function asBase64(file) {
        return new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = () => resolve(reader.result.split(",")[1]);
            reader.onerror = () => reject(new Error("Could not read the selected file."));
            reader.readAsDataURL(file);
        });
    }

    function panel(title, css = "") {
        const previous = document.activeElement;
        const dialog = node("dialog", "", `sr-certificate-review ${css}`);
        dialog.setAttribute("aria-label", title);
        const heading = node("h2", title);
        const body = node("div", "", "sr-web-fields");
        const status = node("p", "", "muted");
        status.setAttribute("role", "status");
        const actions = node("div", "", "sr-actions");
        actions.append(button("Close", () => dialog.close()));
        dialog.append(heading, body, status, actions);
        dialog.addEventListener("close", () => { dialog.remove(); previous?.focus(); }, { once: true });
        document.body.append(dialog);
        dialog.showModal();
        return { dialog, body, status, actions };
    }

    function field(label, type = "text") {
        const row = node("label", label, "form-field");
        const input = node("input");
        input.type = type;
        row.append(input);
        return [row, input];
    }

    function busy(status, control, action) {
        return async () => {
            control.disabled = true;
            status.textContent = "Working…";
            try { await action(); }
            catch (error) { status.textContent = error.message; }
            finally { control.disabled = false; }
        };
    }

    const menus = {
        storeActions: () => [["Manage Sources…", "manage"], ["Refresh Sources", "refresh"]],
        appsActions: d => [
            ...(d.view === "Library" ? [["Import Xcode Build…", "importBuild"], ["Batch History…", "batches"]] : []),
            ["IPA Workshop…", "workshop"], ["Refresh List", "refresh", d.refresh === "1"]],
        installedAppActions: d => [["Refresh Now", "refresh", d.refresh === "1"], ["Versions…", "versions"],
            ["Provisioning Profiles…", "profiles"], ["Documents…", "documents"], ["Delete App…", "delete"]],
        libraryBuildActions: d => [["IPA Details…", "details", d.details === "1"], ["Install Again…", "install", d.install === "1"],
            ...(importedSigning && d.details === "1" ? [["Sign with Imported Identity…", "signImported"]] : []),
            ["Remove from Library…", "remove", d.remove === "1"]],
        activityActions: d => [["Installation Logs…", "logs"], ["Clear Completed Activity…", "clear", d.clear === "1"]],
        deviceListActions: () => [["Remove Device…", "remove"]],
        certificateActions: d => [["Show Details…", "details"], ["Revoke…", "revoke", d.revoke === "1"]],
        accountActions: d => [["Manage App IDs…", "appIDs", d.appIDs === "1"],
            ["Export LiveContainer Certificate", "exportCert", d.exportCert === "1"], ["Remove Account…", "remove", d.remove === "1"]],
    };

    function menu(items, data, separator) {
        return new Promise(resolve => {
            const focus = document.activeElement;
            const dialog = node("dialog", "", "sr-web-menu");
            const list = node("div", "", "sr-web-menu-items");
            list.setAttribute("role", "menu");
            list.setAttribute("aria-label", "Actions");
            dialog.append(list);
            let selection = "";
            for (const [label, value, enabled] of items) {
                if (value === separator) {
                    const rule = node("hr");
                    rule.setAttribute("role", "separator");
                    list.append(rule);
                }
                const item = button(label, () => { selection = value; dialog.close(); });
                item.setAttribute("role", "menuitem");
                item.disabled = enabled === false;
                list.append(item);
            }
            if (!items.length) return resolve("");
            const enabled = [...list.querySelectorAll("button:not(:disabled)")];
            list.addEventListener("keydown", event => {
                if (!enabled.length || !["ArrowUp", "ArrowDown", "Home", "End"].includes(event.key)) return;
                event.preventDefault();
                const current = enabled.indexOf(document.activeElement);
                const offset = event.key === "ArrowUp" ? -1 : 1;
                const index = event.key === "Home" ? 0 : event.key === "End" ? enabled.length - 1
                    : current < 0 ? (offset < 0 ? enabled.length - 1 : 0)
                        : (current + offset + enabled.length) % enabled.length;
                enabled[index].focus();
            });
            dialog.addEventListener("click", event => { if (event.target === dialog) dialog.close(); });
            dialog.addEventListener("close", () => { dialog.remove(); focus?.focus(); resolve(selection); }, { once: true });
            document.body.append(dialog);
            dialog.showModal();
            dialog.style.left = `${Math.max(8, Math.min(Number(data.x) || 8, innerWidth - dialog.offsetWidth - 8))}px`;
            dialog.style.top = `${Math.max(8, Math.min(Number(data.y) || 8, innerHeight - dialog.offsetHeight - 8))}px`;
            enabled[0]?.focus();
        });
    }

    async function workshop(start) {
        const { body, status, actions } = panel("IPA Workshop");
        const [fileRow, file] = field("Import an IPA", "file");
        file.accept = ".ipa";
        const builds = node("select");
        const chooser = node("label", "Library Build", "form-field");
        chooser.append(builds);
        const [nameRow, name] = field("App Name");
        const [idRow, identifier] = field("Bundle ID");
        const [osRow, minimum] = field("Minimum OS");
        const [iconRow, icon] = field("Replace App Icon", "file");
        icon.accept = ".png,.jpg,.jpeg";
        const [filesRow, files] = field("Add Libraries or Debian Packages", "file");
        files.accept = ".dylib,.deb";
        files.multiple = true;
        const [folderRow, folder] = field("Add a Framework or Resource Bundle", "file");
        folder.setAttribute("webkitdirectory", "");
        const [sharingRow, sharing] = field("Enable File Sharing", "checkbox");
        const [modelsRow, models] = field("Remove Device Model Restrictions", "checkbox");
        const extensions = node("fieldset");
        extensions.append(node("legend", "Remove Extensions"));
        const components = node("details", "", "sr-web-fields");
        components.append(node("summary", "Embed Components"), filesRow, folderRow);
        body.append(fileRow, chooser, nameRow, idRow, osRow, iconRow, sharingRow, modelsRow, extensions, components);
        const { upload } = globalThis.sideRelayCatalogue;
        const reload = async selected => {
            const { packages } = await request({ action: "ipaLibrary", operation: "list" });
            builds.replaceChildren(new Option("Select a build…", ""), ...packages.filter(ipa => ipa.available)
                .map(ipa => new Option(`${ipa.displayName} ${globalThis.sideRelayCatalogue.packageVersion(ipa)}`, ipa.id)));
            builds.value = selected || "";
            await inspect();
        };
        async function inspect() {
            extensions.replaceChildren(node("legend", "Remove Extensions"));
            extensions.hidden = true;
            iconRow.hidden = true;
            components.hidden = true;
            icon.value = files.value = folder.value = "";
            name.value = identifier.value = minimum.value = "";
            if (!builds.value) return;
            const result = await request({ action: "workshopInfo", packageId: builds.value });
            name.value = result.name || "";
            identifier.value = result.identifier || "";
            minimum.value = result.minimum || "";
            iconRow.hidden = result.platform !== "iPhoneOS";
            components.hidden = result.platform !== "iPhoneOS";
            for (const item of result.extensions || []) {
                const [label, input] = field(item.name, "checkbox");
                input.value = item.path;
                extensions.append(label);
            }
            extensions.hidden = extensions.childElementCount === 1;
            status.textContent = "";
        }
        builds.addEventListener("change", () => { void inspect().catch(error => { status.textContent = error.message; }); });
        file.addEventListener("change", busy(status, file, async () => {
            if (!file.files.length) return;
            const item = await upload("import", file.files[0]);
            await reload(item.id);
        }));
        async function prepare(destination) {
            if (!builds.value) throw new Error("Select an IPA first.");
            const selected = icon.files[0];
            if (selected?.size > 2 * 1024 * 1024) throw new Error("Choose an icon smaller than 2 MB.");
            const options = { packageId: builds.value, name: name.value, identifier: identifier.value,
                minimum: minimum.value, sharing: sharing.checked, removeDeviceModels: models.checked, destination,
                icon: selected ? await asBase64(selected) : "",
                remove: [...extensions.querySelectorAll("input:checked")].map(input => input.value) };
            const attachments = [...files.files, ...folder.files];
            const prepared = await (attachments.length ? postFiles("workshop", options, attachments) : post("workshop", options));
            if (destination === "library") {
                await reload((await prepared.json()).id);
                globalThis.sideRelayAppsChanged?.();
                status.textContent = "Prepared IPA added to Library.";
            } else {
                save(await prepared.blob(), "SideRelay-prepared.ipa");
                status.textContent = "Prepared IPA downloaded.";
            }
        }
        const exportButton = button("Download IPA", () => busy(status, exportButton, () => prepare("file"))());
        const keep = button("Save to Library", () => busy(status, keep, () => prepare("library"))(), true);
        actions.append(exportButton, keep);
        void reload(start).catch(error => { status.textContent = error.message; });
    }

    function importBuild() {
        return new Promise(resolve => {
            const { dialog, body, status, actions } = panel("Import Xcode Build");
            const [row, files] = field("iPhone or iPad .app", "file");
            files.setAttribute("webkitdirectory", "");
            body.append(row);
            dialog.addEventListener("close", () => resolve({ cancelled: true }), { once: true });
            const add = button("Import Build", () => busy(status, add, async () => {
                if (!files.files.length) throw new Error("Choose an iPhone or iPad .app folder.");
                resolve(await (await postFiles("import-build", {}, [...files.files])).json());
                dialog.close();
            })(), true);
            actions.append(add);
        });
    }

    let acceptBuildDrop = false;
    let importingBuild = false;
    function droppedBuild(event) {
        if (!acceptBuildDrop || !event.dataTransfer?.types.includes("Files") ||
            location.pathname !== "/" || location.search !== "?view=apps") return null;
        const items = [...event.dataTransfer.items];
        if (items.length !== 1 || items[0].kind !== "file") return null;
        return items[0].webkitGetAsEntry?.() || null;
    }
    async function readBuild(entry, files, paths) {
        if (entry.isDirectory) {
            const reader = entry.createReader();
            while (true) {
                const children = await new Promise((resolve, reject) => reader.readEntries(resolve, reject));
                if (!children.length) break;
                for (const child of children) await readBuild(child, files, paths);
            }
        } else if (entry.isFile) {
            if (files.length >= 20000) throw new Error("This build contains too many files.");
            files.push(await new Promise((resolve, reject) => entry.file(resolve, reject)));
            paths.push(entry.fullPath.replace(/^\//, ""));
        }
    }
    document.addEventListener("dragover", event => {
        if (acceptBuildDrop && location.search === "?view=apps" && event.dataTransfer?.types.includes("Files")) {
            event.preventDefault();
            event.dataTransfer.dropEffect = "copy";
        }
    });
    document.addEventListener("drop", async event => {
        const build = droppedBuild(event);
        if (!build) return;
        event.preventDefault();
        if (importingBuild || !build.isDirectory || !/\.app$/i.test(build.name)) return;
        const receive = globalThis.sideRelayBuildDrop;
        if (!receive) return;
        importingBuild = true;
        try {
            const files = [], paths = [];
            void receive({ pending: true });
            await readBuild(build, files, paths);
            await receive(await (await postFiles("import-build", {}, files, paths)).json());
        } catch (error) {
            await receive({ error: error.message || "Could not import the Xcode build." });
        } finally { importingBuild = false; }
    });

    function backups() {
        const { body, status, actions } = panel("SideRelay Backup");
        const [passwordRow, password] = field("Backup Password", "password");
        password.autocomplete = "off";
        const [fileRow, file] = field("Backup to Restore", "file");
        file.accept = ".siderelaybackup";
        body.append(passwordRow, fileRow);
        function secret() {
            if (!password.value) throw new Error("Enter a backup password.");
            return { "X-SideRelay-Password": btoa(String.fromCharCode(...new TextEncoder().encode(password.value))) };
        }
        const exportButton = button("Export Backup", () => busy(status, exportButton, async () => {
            save(await (await post("backup/export", {}, secret())).blob(), "SideRelay.siderelaybackup");
            status.textContent = "Backup downloaded.";
        })());
        const restore = button("Restore Backup", () => busy(status, restore, async () => {
            if (!file.files.length) throw new Error("Choose a SideRelay backup.");
            const packageFile = file.files[0];
            const headers = secret();
            const preview = await (await post("backup/review", packageFile, headers, true)).json();
            if (!confirm(`Restore ${preview.packages} IPA builds and ${preview.sources} sources?`)) {
                status.textContent = "";
                return;
            }
            const result = await (await post("backup/restore", packageFile, headers, true)).json();
            status.textContent = `${result.restored} IPA builds restored${result.failed ? ` · ${result.failed} failed` : ""}.`;
            if (result.devicesToPair.length) status.append(` Pair again: ${result.devicesToPair.join(", ")}.`);
            if (result.accountsToConnect.length) status.append(` Reconnect: ${result.accountsToConnect.join(", ")}.`);
        })(), true);
        actions.append(exportButton, restore);
    }

    async function signImported(packageId) {
        const { dialog, body, status, actions } = panel("Sign with Imported Identity");
        const [deviceRow, device] = field("iPhone or iPad");
        const select = node("select");
        device.replaceWith(select);
        const [certificateRow, certificate] = field("Certificate (.p12)", "file");
        certificate.accept = ".p12";
        const [passwordRow, password] = field("Certificate Password", "password");
        password.autocomplete = "off";
        password.maxLength = 4096;
        const [profilesRow, profiles] = field("Provisioning Profiles", "file");
        profiles.accept = ".mobileprovision";
        profiles.multiple = true;
        body.append(deviceRow, certificateRow, passwordRow, profilesRow);
        const cancel = actions.firstElementChild;
        cancel.textContent = "Cancel";
        const exportButton = button("Sign and Download", async () => {
            exportButton.disabled = cancel.disabled = true;
            exportButton.textContent = "Signing…";
            status.textContent = "";
            try {
                const response = postFiles("sign-imported", { packageId, deviceId: select.value, password: password.value },
                    [certificate.files[0], ...profiles.files]);
                password.value = "";
                const result = await response;
                if (result.headers.get("Content-Type")?.startsWith("application/json")) {
                    const report = await result.json();
                    const issues = (report.components || []).flatMap(item => item.errors.map(error => `${item.bundle} — ${error}`));
                    status.textContent = issues.join("\n") || "Check the certificate and provisioning profiles.";
                } else {
                    save(await result.blob(), "SideRelay-signed.ipa");
                    dialog.close();
                }
            } catch (error) {
                status.textContent = error.message;
            } finally {
                cancel.disabled = false;
                exportButton.textContent = "Sign and Download";
                update();
            }
        }, true);
        const update = () => {
            exportButton.disabled = cancel.disabled || !select.value || !certificate.files.length || !profiles.files.length;
        };
        actions.append(exportButton);
        for (const input of [select, certificate, profiles]) input.addEventListener("change", update);
        dialog.addEventListener("cancel", event => { if (cancel.disabled) event.preventDefault(); });
        update();
        try {
            const devices = (await globalThis.sideRelayJobs.requete("list_devices"))
                .filter(item => item.discovery !== "coredevice-tvos" && item.udid);
            if (!dialog.open) return;
            select.append(new Option("Choose…", ""), ...devices.map(item => new Option(item.name, item.id)));
            if (devices.length === 1) select.value = devices[0].id;
            if (!devices.length) status.textContent = "Pair an iPhone or iPad in Devices.";
            update();
        } catch (error) {
            status.textContent = error.message;
        }
    }

    async function chooseInbox() {
        const settings = await request({ action: "ipaInboxSettings" });
        const { dialog, body, status, actions } = panel("Choose IPA Inbox");
        const [row, path] = field("Folder Path in the Container");
        path.value = settings.path;
        path.autocomplete = "off";
        const form = node("form", "", "sr-web-fields");
        form.append(row, node("p", "For folders on the host, use the path where they are mounted in the container.", "muted"));
        body.append(form);
        actions.firstElementChild.textContent = "Cancel";
        const choose = button("Choose", () => form.requestSubmit(), true);
        actions.append(choose);
        path.focus();
        path.select();
        return new Promise(resolve => {
            let result = { cancelled: true };
            dialog.addEventListener("close", () => resolve(result), { once: true });
            form.addEventListener("submit", event => {
                event.preventDefault();
                void busy(status, choose, async () => {
                    result = await request({ action: "selectIPAInbox", path: path.value.trim() });
                    dialog.close();
                })();
            });
        });
    }

    function importPairing(trigger, scan, selectedAddress = "") {
        if (document.querySelector(".sr-pair-import[open]")) return;
        const dialog = node("dialog", "", "sr-pair-dialog sr-pair-import");
        const heading = node("h2", "Import Pairing File");
        heading.id = "sr-pair-import-title";
        heading.tabIndex = -1;
        dialog.setAttribute("aria-labelledby", heading.id);
        const [addressRow, address] = field("iPhone or iPad Address");
        address.required = true;
        address.placeholder = "Local network or Tailscale IP";
        address.autocapitalize = "off";
        address.spellcheck = false;
        address.value = selectedAddress;
        const choicesRow = node("label", "Detected Devices", "form-field");
        const choices = node("select");
        choicesRow.hidden = true;
        choicesRow.append(choices);
        choices.addEventListener("change", () => {
            if (choices.value) address.value = choices.value;
        });
        address.addEventListener("input", () => { choices.value = address.value.trim(); });
        const [fileRow, file] = field("Pairing file (.plist)", "file");
        file.required = true;
        file.accept = ".plist,application/x-plist";
        const form = node("form", "", "sr-web-fields");
        const status = node("p", "", "sr-feedback");
        status.setAttribute("role", "status");
        const actions = node("div", "", "sr-pair-actions");
        const cancel = button("Cancel", () => dialog.close());
        const add = node("button", "Add Device", "btn btn-primary");
        add.type = "submit";
        actions.append(cancel, add);
        form.append(choicesRow, addressRow, fileRow, status, actions);
        dialog.append(heading, node("p", "Enter the device’s reachable IP address and choose its Remote Pairing file.", "sr-pair-intro"), form);
        dialog.addEventListener("close", () => {
            dialog.remove();
            trigger.focus({ preventScroll: true });
        }, { once: true });
        dialog.addEventListener("cancel", event => {
            if (add.disabled) event.preventDefault();
        });
        form.addEventListener("submit", async event => {
            event.preventDefault();
            if (add.disabled) return;
            add.disabled = cancel.disabled = true;
            add.textContent = "Adding…";
            status.textContent = "";
            try {
                await globalThis.sideRelayJobs.requete("register_device", {
                    ip: address.value.trim(), pairing_blob_b64: await asBase64(file.files[0]),
                }, AbortSignal.timeout(60000));
                location.replace("/devices");
            } catch (error) {
                let message;
                try { message = JSON.parse(error.message).message; } catch {}
                status.textContent = message || "Could not add the device. Check its address and use a valid Remote Pairing file.";
                add.textContent = "Add Device";
                add.disabled = cancel.disabled = false;
            }
        });
        document.body.append(dialog);
        dialog.showModal();
        heading.focus();
        void scan.then(results => {
            if (!dialog.open) return;
            const devices = [
                ...(results?.wifi?.devices || []).map(device => ({ ...device, network: "Bonjour" })),
                ...(results?.tailscale?.devices || []).filter(device => device.online).map(device => ({ ...device, network: "Tailscale" })),
            ];
            if (!devices.length) return;
            const preferred = root.dataset.srConnection === "tailscale" ? "Tailscale" : "Bonjour";
            devices.sort((a, b) => Number(b.network === preferred) - Number(a.network === preferred));
            const preferredDevices = devices.filter(device => device.network === preferred);
            choices.append(new Option("Choose a nearby device…", ""), ...devices.map(device =>
                new Option(`${device.name} · ${device.network} · ${device.address}`, device.address)));
            if (!address.value) {
                if (preferredDevices.length === 1) address.value = preferredDevices[0].address;
                else if (devices.length === 1) address.value = devices[0].address;
            }
            choices.value = address.value;
            choicesRow.hidden = false;
        });
    }

    const deviceScans = new WeakMap();

    function deviceDiscovery(section) {
        const header = node("div", "", "sr-section-header");
        const actions = node("div", "", "sr-actions");
        const status = node("p", "", "sr-device-empty sr-device-scan-status");
        status.setAttribute("role", "status");
        let pending;
        let scanning = false;
        const scan = button("Scan Again", () => void search());
        const add = button("Import Pairing File…", () => importPairing(add, pending), true);
        add.setAttribute("aria-haspopup", "dialog");
        const wifi = button("Pair over Wi-Fi…", () => void pair("wifi"), true);
        wifi.hidden = true;
        wifi.setAttribute("aria-haspopup", "dialog");
        actions.append(wifi, add, scan);
        header.append(node("h2", "Available Devices"), actions);
        section.append(header, status);

        const lists = new Map();
        const sources = [["usb", "USB"], ["wifi", "Local Network · Bonjour"], ["tailscale", "Tailscale"]];
        if (appleTV) sources.push(["tvos", "Apple TV"]);
        for (const [source, title] of sources) {
            const group = node("section", "", "sr-device-group");
            const rows = node("div", "", "sr-device-rows");
            group.hidden = true;
            group.append(node("h3", title), rows);
            section.append(group);
            lists.set(source, { group, rows });
        }

        async function pair(mode, device, address) {
            const result = await pending;
            if (!section.isConnected || !result?.pairing || !globalThis.sideRelayPair) return;
            const adresses = [
                ...result.wifi.devices.map(record => ({ ...record, source: "wifi" })),
                ...result.tailscale.devices.filter(record => record.online).map(record => ({ ...record, source: "tailscale" })),
            ];
            return globalThis.sideRelayPair({ mode, appareil: device, adresses, adresse: address, connexion: root.dataset.srConnection });
        }

        async function registerAppleTV(device, control) {
            scan.disabled = control.disabled = true;
            status.textContent = device.paired ? "Adding Apple TV…" : "Complete the pairing prompt on the Apple TV or Mac.";
            try {
                const television = device.paired ? device : await request({ action: "pairAppleTV", device: device.id });
                await globalThis.sideRelayJobs.requete("apple_tv_devices",
                    { udid: television.udid }, AbortSignal.timeout(25000));
                location.replace("/devices");
            } catch (error) {
                const detail = globalThis.sideRelayJobs.messageErreur(error.message, "Could not add the Apple TV. Scan again to retry.");
                status.textContent = detail;
                scan.disabled = control.disabled = false;
            }
        }

        function search() {
            if (scanning) return pending;
            scanning = scan.disabled = true;
            status.textContent = "Finding nearby devices…";
            pending = request({ action: "deviceDiscovery" }).then(result => {
                wifi.hidden = !result.pairing;
                add.classList.toggle("btn-primary", !result.pairing);
                add.classList.toggle("btn-secondary", Boolean(result.pairing));
                let count = 0;
                for (const [source, { group, rows }] of lists) {
                    const devices = result[source]?.devices || [];
                    group.hidden = !devices.length;
                    count += devices.length;
                    rows.replaceChildren(...devices.map(device => {
                        const row = node("div", "", "sr-device-row");
                        const identity = node("div", "", "sr-device-identity");
                        if (source === "tvos") {
                            const title = device.paired ? "Add Apple TV" : "Pair Apple TV…";
                            const state = device.paired ? "Paired with the Mac" : "Ready to pair";
                            identity.append(node("strong", device.name),
                                node("small", [device.osVersion && `tvOS ${device.osVersion}`, state].filter(Boolean).join(" · ")));
                            const add = button(title, () => void registerAppleTV(device, add));
                            add.setAttribute("aria-label", `${title} · ${device.name}`);
                            row.append(identity, add);
                            return row;
                        }
                        const state = source === "usb" ? "Connected via USB" : source === "tailscale"
                            ? (device.online ? "Online" : "Offline")
                            : (device.remotePairing ? "Remote pairing available" : "Discovered");
                        identity.append(node("strong", device.name), node("small", device.address ? `${state} · ${device.address}` : state));
                        if (source === "usb") {
                            const open = button("Pair via USB…", () => void pair("usb", device));
                            open.setAttribute("aria-label", `Pair via USB… · ${device.name}`);
                            open.setAttribute("aria-haspopup", "dialog");
                            row.append(identity, open);
                            return row;
                        }
                        const open = button("Import Pairing File…", () => importPairing(open, pending, device.address));
                        open.setAttribute("aria-label", `Import Pairing File… · ${device.name}`);
                        open.setAttribute("aria-haspopup", "dialog");
                        const commands = node("div", "", "sr-actions");
                        if (result.pairing && (device.online || device.remotePairing)) {
                            const connect = button("Pair…", () => void pair("wifi", device, device.address));
                            connect.setAttribute("aria-label", `Pair… · ${device.name}`);
                            connect.setAttribute("aria-haspopup", "dialog");
                            commands.append(connect);
                        } else {
                            commands.append(open);
                        }
                        row.append(identity, commands);
                        return row;
                    }));
                }
                const states = [...lists.keys()].map(source => result[source]?.status);
                status.textContent = count ? ""
                    : states.includes("permission") ? "Allow local network discovery on the Mac, then scan again."
                    : states.includes("ready") ? appleTV
                        ? "No new devices found. To pair an Apple TV, open Settings → Remotes and Devices → Remote App and Devices."
                        : "No new devices found. Keep your iPhone unlocked and on the same network."
                    : "Discovery is unavailable. You can still import a pairing file.";
                return result;
            }).catch(() => {
                status.textContent = "Could not discover devices. Scan again or add a device by address.";
            }).finally(() => { scanning = scan.disabled = false; });
            return pending;
        }

        void search();
        return { add, results: () => pending };
    }

    function mountDevices(main) {
        const source = main?.querySelector('input[name="pairing_blob_b64"]')?.closest(".card");
        if (!source) return;
        const devices = [...source.parentElement.querySelectorAll(":scope > .card")].find(card => card !== source);
        if (devices && !devices.classList.contains("sr-device-registered")) {
            devices.classList.add("sr-device-registered");
            const heading = devices.querySelector("h2");
            if (heading) heading.textContent = "My Devices";
        }
        let discovery = main.querySelector(".sr-web-devices");
        if (!discovery) {
            discovery = node("section", "", "sr-device-discovery sr-web-devices");
            deviceScans.set(discovery, deviceDiscovery(discovery));
            source.classList.add("sr-web-device-source");
            (devices || source).after(discovery);
        }
        if (new URLSearchParams(location.search).get("add") === "1") {
            history.replaceState(history.state, "", "/devices");
            currentRoute = location.href;
            const scan = deviceScans.get(discovery);
            importPairing(scan.add, scan.results());
        }
    }

    const appleTV = Boolean(document.querySelector('meta[name="siderelay-apple-tv"][content="1"]'));
    const liveContainer = Boolean(document.querySelector('meta[name="siderelay-livecontainer"][content="1"]'));
    const importedSigning = Boolean(document.querySelector('meta[name="siderelay-imported-signing"][content="1"]'));
    globalThis.sideRelayWebBridge = { appleTV, liveContainer, downloadIPA, async postMessage(data) {
        const { action } = data;
        if (action === "portal") {
            const state = await request(data);
            return { ...state, expiryNotificationsAvailable, expiryNotifications: expiryNotificationsAvailable
                && Notification.permission === "granted" && localStorage.getItem(alertsPreference) === "yes" };
        }
        if (action === "expiryNotifications") {
            const enabled = data.enabled === "true" && expiryNotificationsAvailable
                && (await Notification.requestPermission()) === "granted";
            localStorage.setItem(alertsPreference, enabled ? "yes" : "no");
            if (enabled) void expiryAlerts();
            return enabled;
        }
        const separators = { installedAppActions: "delete", libraryBuildActions: "remove",
            activityActions: "clear", certificateActions: "revoke", accountActions: "remove" };
        if (Object.hasOwn(menus, action)) return menu(menus[action](data), data,
            action === "appsActions" && data.view === "Library" ? "workshop" : separators[action]);
        if (action === "windowNavigation") return true;
        if (action === "libraryDropEnabled") {
            acceptBuildDrop = data.enabled === "yes";
            return true;
        }
        if (action === "portableBackup") {
            backups();
            return {};
        }
        if (action === "signImported" && importedSigning) return signImported(data.packageId);
        if (action === "chooseIPAInbox") return chooseInbox();
        if (action === "chooseXcodeBuild") return importBuild();
        if (action === "workshop" || action === "ipaLibrary" && data.operation === "edit-path") {
            await workshop(data.packageId);
            return { opened: true };
        }
        if (action === "showSignedBatch") {
            const link = node("a");
            link.href = `/_siderelay/signed/${encodeURIComponent(data.batchId)}`;
            link.download = "SideRelay-signed-IPAs.zip";
            link.click();
            return true;
        }
        if (action === "installLogs") {
            const { log } = await request(data);
            const { body, actions } = panel("Installation Logs");
            body.append(node("pre", log || "No log entries."));
            if (log) actions.prepend(button("Download Log", () => save(new Blob([log], { type: "text/plain" }), "SideRelay-Installation.log")));
            return true;
        }
        if (action === "revokeCertificate") {
            const plan = await globalThis.sideRelayJobs.requete("prepare_certificate_revocation", { account_id: data.accountID, serial: data.serial });
            const [certificate] = plan.certificates;
            const affected = certificate.apps.map(app => `${app.name} · ${app.device}`).join("\n");
            if (!confirm(`Revoke ${certificate.label}?\n${affected}`)) return { cancelled: true };
            return request({ action: "replaceCertificate", token: plan.token, serial: certificate.serial });
        }
        if (action === "replaceCertificate" && !confirm(`Revoke ${data.certificate}?\n${data.impact || ""}`)) return { cancelled: true };
        return request(data);
    } };

    const compact = matchMedia("(max-width: 620px)");
    const offeredUpdate = "siderelay.last-offered-docker-update";
    let dockerUpdate;
    let currentRoute = location.href;
    let nav, toggle;
    let updateButton;
    const sidebarPreference = "sideRelaySidebar";
    let sidebarOpen = !compact.matches && sessionStorage.getItem(sidebarPreference) !== "closed";

    function offerDockerUpdate(manual = false) {
        if (!dockerUpdate || document.querySelector("dialog[open]")) return;
        const { version, current, url } = dockerUpdate;
        if (!manual && (document.hidden || !document.hasFocus() || localStorage.getItem(offeredUpdate) === version)) return;
        localStorage.setItem(offeredUpdate, version);
        const { dialog, body, status, actions } = panel(`Update SideRelay to ${version}?`);
        body.append(node("p", `You’re using version ${current}. Open the GitHub release for downloads and update instructions?`));
        status.remove();
        actions.firstElementChild.textContent = "No";
        const yes = node("a", "Yes", "btn btn-primary");
        yes.href = url;
        yes.target = "_blank";
        yes.rel = "noopener";
        yes.addEventListener("click", () => dialog.close());
        actions.append(yes);
    }

    async function checkDockerUpdate() {
        try {
            const result = await request({ action: "dockerUpdate" });
            dockerUpdate = result.update;
            updateButton.hidden = !dockerUpdate;
            offerDockerUpdate();
        } catch { /* Keep the last offer if GitHub is temporarily unavailable. */ }
    }

    function showSidebar(open) {
        sidebarOpen = open;
        if (!compact.matches) sessionStorage.setItem(sidebarPreference, open ? "open" : "closed");
        root.toggleAttribute("data-sr-web-sidebar", open);
        toggle.setAttribute("aria-expanded", String(open));
        toggle.setAttribute("aria-label", open ? "Hide Sidebar" : "Show Sidebar");
        nav.hidden = !open;
    }

    function navigation() {
        if (currentRoute !== location.href) {
            currentRoute = location.href;
            for (const dialog of document.querySelectorAll("dialog[open]")) dialog.close();
        }
        if (document.title !== "SideRelay") document.title = "SideRelay";
        if (!nav) {
            nav = node("nav", "", "sr-web-nav");
            nav.id = "sr-web-sidebar";
            nav.setAttribute("aria-label", "SideRelay navigation");
            for (const [title, url, icon] of [
                ["Overview", "/", "dashboard"],
                ["Library"], ["Apps", "/?view=apps", "apps"], ["Store", "/?view=store", "store"],
                ["Management"], ["Devices", "/devices", "devices"], ["Apple Accounts", "/accounts", "accounts"],
                ["Activity", "/queue", "queue"], ["Settings", "/settings", "settings"],
            ]) {
                if (!url) {
                    nav.append(node("div", title, "sr-web-nav-group"));
                } else {
                    const link = node("a", title);
                    link.href = url;
                    link.dataset.icon = icon;
                    link.addEventListener("click", event => {
                        if (event.button !== 0 || event.metaKey || event.ctrlKey || event.altKey || event.shiftKey) return;
                        event.preventDefault();
                        event.stopPropagation();
                        if (compact.matches) showSidebar(false);
                        if (link.href !== location.href) location.assign(link.href);
                    });
                    nav.append(link);
                }
            }
            const signOut = node("form", "", "sr-web-sign-out");
            signOut.method = "post";
            signOut.action = "/_siderelay/logout";
            const signOutButton = node("button", "Sign Out", "btn btn-secondary");
            signOutButton.type = "submit";
            signOut.append(signOutButton);
            const footer = node("div", "", "sr-web-nav-footer");
            updateButton = button("Update Available", () => offerDockerUpdate(true));
            updateButton.classList.add("sr-web-update");
            updateButton.hidden = true;
            footer.append(signOut, updateButton);
            nav.append(footer);
            const toolbar = node("div", "", "sr-web-toolbar");
            toggle = button("", () => showSidebar(!sidebarOpen));
            toggle.classList.add("sr-web-sidebar-toggle");
            toggle.setAttribute("aria-controls", nav.id);
            toolbar.append(toggle);
            const back = node("a", "Devices", "btn btn-secondary sr-web-device-back");
            back.href = "/devices";
            toolbar.append(back);
            document.body.prepend(toolbar, nav);
            showSidebar(sidebarOpen);
            compact.addEventListener("change", event => showSidebar(!event.matches && sessionStorage.getItem(sidebarPreference) !== "closed"));
            document.addEventListener("pointerdown", event => {
                if (compact.matches && sidebarOpen && !nav.contains(event.target) && !toolbar.contains(event.target)) {
                    showSidebar(false);
                }
            });
            nav.addEventListener("keydown", event => {
                if (event.key === "Escape") {
                    showSidebar(false);
                    toggle.focus();
                }
            });
        }
        const onDevice = location.pathname.startsWith("/devices/");
        const back = document.querySelector(".sr-web-device-back");
        back.hidden = !onDevice;
        const active = onDevice ? "/devices" : location.pathname + (location.pathname === "/" ? location.search : "");
        for (const link of nav.querySelectorAll("a")) {
            const selected = link.getAttribute("href") === active;
            if (selected && !link.hasAttribute("aria-current")) link.setAttribute("aria-current", "page");
            if (!selected && link.hasAttribute("aria-current")) link.removeAttribute("aria-current");
        }
        if (location.pathname === "/devices") mountDevices(document.querySelector("main.main-content"));
    }
    new MutationObserver(navigation).observe(document.body, { childList: true, subtree: true });
    window.addEventListener("popstate", navigation);
    window.addEventListener("focus", expiryAlerts);
    window.setInterval(expiryAlerts, 300000);
    window.addEventListener("focus", () => offerDockerUpdate());
    document.addEventListener("close", () => offerDockerUpdate(), true);
    window.setInterval(checkDockerUpdate, 6 * 60 * 60 * 1000);
    void expiryAlerts();
    navigation();
    void checkDockerUpdate();
})();
