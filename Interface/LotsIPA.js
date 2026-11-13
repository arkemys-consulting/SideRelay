(() => {
    if (location.origin !== "http://127.0.0.1:18784") return;
    const bridge = window.webkit.messageHandlers.signatureCompte;

    function controller(ui) {
        const { node, button, feedback, selectField, comparison, packageDetails, packageVersion, installedApps } = ui;
        const request = (...args) => globalThis.sideRelayJobs.requete(...args);
        const detail = (error, fallback) => {
            const text = error instanceof Error ? error.message : String(error || "");
            const formatted = globalThis.sideRelayJobs.messageErreur(text, "");
            return formatted || text.replace(/^error running server function:\s*/i, "").slice(0, 420) || fallback;
        };

        function panel(title) {
            if (document.querySelector(".sr-package-dialog[open]")) return null;
            const dialog = node("dialog", "", "sr-certificate-review sr-package-dialog sr-batch-dialog");
            const heading = node("h2", title);
            heading.id = "sr-batch-heading";
            dialog.setAttribute("aria-labelledby", heading.id);
            const content = node("div");
            const status = feedback();
            const actions = node("div", "", "sr-actions");
            const close = button("Close", () => dialog.close());
            actions.append(close);
            dialog.append(heading, content, status, actions);
            dialog.addEventListener("close", () => dialog.remove(), { once: true });
            document.body.append(dialog);
            dialog.showModal();
            return { dialog, content, status, actions, close };
        }

        async function review(packages, library, refresh, draft) {
            const view = panel("Review Batch");
            if (!view) return;
            const { dialog, content, status, actions, close } = view;
            close.textContent = "Cancel";
            dialog.addEventListener("cancel", event => {
                if (close.disabled) event.preventDefault();
            });
            status.textContent = "Loading devices and accounts…";
            try {
                const [devices, accounts, apps] = await Promise.all([
                    request("list_devices"), request("list_accounts"), installedApps(),
                ]);
                if (!dialog.open) return;
                const device = selectField("iPhone", devices, "name");
                const account = selectField("Apple Account", accounts, "apple_id");
                const mode = selectField("Operation", [
                    { id: "install", name: "Sign & Install" }, { id: "sign", name: "Sign Only" },
                ], "name");
                mode.select.remove(0);
                mode.select.value = "install";
                const fields = node("div", "", "sr-package-targets");
                fields.append(mode.label, device.label, account.label);
                content.append(fields);
                const list = node("div", "", "sr-batch-list");
                const previews = packages.map(ipa => {
                    const item = node("details");
                    const label = [ipa.displayName, packageVersion(ipa)].filter(Boolean).join(" · ");
                    const effect = node("p", "", "sr-batch-effect");
                    item.append(node("summary", label), packageDetails(ipa));
                    const wrapper = node("div", "", "sr-batch-item");
                    wrapper.append(item, effect);
                    list.append(wrapper);
                    return { ipa, effect };
                });
                content.append(list);
                const start = button("Start Batch", async control => {
                    if (control.disabled) return;
                    control.disabled = true;
                    close.disabled = true;
                    for (const field of [device, account, mode]) field.select.disabled = true;
                    status.textContent = "Queuing batch…";
                    try {
                        const archived = draft ? await draft.archive(text => { status.textContent = text; }) : packages;
                        if (new Set(archived.map(ipa => ipa.id)).size < 2 && draft) {
                            throw new Error("These files are the same IPA. Remove the duplicate and add a different IPA.");
                        }
                        const items = previews.map(({ ipa }, index) => ({
                            packageId: archived[index].id,
                            targetAppId: mode.select.value === "install"
                                ? comparison(ipa, apps, device.select.value, account.select.value, undefined, library).target?.id
                                : undefined,
                        }));
                        const id = await request("start_ipa_batch", {
                            mode: mode.select.value, device_id: device.select.value,
                            account_id: account.select.value, packages_json: JSON.stringify(items),
                        });
                        draft?.onStarted();
                        if (dialog.open) {
                            dialog.close();
                            show(id, refresh);
                        }
                    } catch (error) {
                        close.disabled = false;
                        control.disabled = false;
                        for (const field of [device, account, mode]) field.select.disabled = false;
                        status.textContent = detail(error, "Could not start the batch.");
                    }
                }, "btn btn-primary");
                actions.append(start);
                function update() {
                    const duplicate = mode.select.value === "install" &&
                        new Set(packages.map(ipa => ipa.bundleId)).size !== packages.length;
                    for (const { ipa, effect } of previews) {
                        const result = mode.select.value === "install"
                            ? comparison(ipa, apps, device.select.value, account.select.value, undefined, library) : {};
                        effect.textContent = result.text || "";
                        effect.classList.toggle("sr-app-issue", Boolean(result.warning));
                    }
                    start.disabled = !device.select.value || !account.select.value || duplicate || packages.length > 32;
                    start.textContent = mode.select.value === "sign" ? "Sign Batch" : "Install Batch";
                    if (duplicate) status.textContent = "Select one version of each app for installation.";
                    else if (packages.length > 32) status.textContent = "Select up to 32 IPAs.";
                    else if (!device.select.value || !account.select.value) {
                        status.textContent = "Select an iPhone and Apple Account.";
                    } else status.textContent = mode.select.value === "sign" ? "Signed IPAs will be available in Finder." : "";
                }
                for (const field of [device, account, mode]) field.select.addEventListener("change", update);
                update();
            } catch {
                status.textContent = "Could not load devices or Apple Accounts.";
            }
        }

        function outcome(item, mode) {
            if (item.status === "done") return mode === "sign" ? "Signed" : "Installed";
            if (item.status === "failed") return "Failed";
            if (item.status === "queued") return "Queued";
            if (mode === "sign") return "Signing…";
            const stage = { uploading: "Uploading", installing: "Installing", zipping: "Preparing IPA" }[item.stage];
            return stage ? `${stage} · ${item.progress || 0}%` : "Preparing installation…";
        }

        function show(id, refresh) {
            const view = panel("Batch Progress");
            if (!view) return;
            const { dialog, content, status, actions } = view;
            let timer;
            let cycle = 0;
            const device = node("p", "", "muted");
            const list = node("div", "", "sr-batch-list");
            content.append(device, list);
            const reload = button("Check Again", () => load());
            reload.hidden = true;
            const reveal = button("Show Signed IPAs", async () => {
                try { await bridge.postMessage({ action: "showSignedBatch", batchId: id }); }
                catch { status.textContent = "Could not open the signed IPA folder."; }
            });
            reveal.hidden = true;
            const retry = button("Retry Failed", async control => {
                control.disabled = true;
                try {
                    await request("retry_ipa_batch", { batch_id: id });
                    await load();
                } catch (error) {
                    status.textContent = detail(error, "Could not retry this batch.");
                    control.disabled = false;
                }
            }, "btn btn-primary");
            retry.hidden = true;
            actions.append(reload, reveal, retry);
            dialog.addEventListener("close", () => clearTimeout(timer), { once: true });
            async function load() {
                const current = ++cycle;
                clearTimeout(timer);
                try {
                    const batch = await request("ipa_batch_status", { batch_id: id });
                    if (!dialog.open || current !== cycle) return;
                    device.textContent = [batch.deviceName, batch.accountName].join(" · ");
                    const active = batch.total - batch.succeeded - batch.failed;
                    reload.hidden = true;
                    reveal.hidden = batch.mode !== "sign" || !batch.succeeded;
                    retry.hidden = Boolean(active || !batch.failed);
                    retry.disabled = false;
                    status.textContent = [`${batch.succeeded} of ${batch.total} complete`,
                        batch.failed ? `${batch.failed} failed` : ""].filter(Boolean).join(" · ");
                    list.replaceChildren();
                    for (const item of batch.items) {
                        const row = node("div", "", "sr-batch-item");
                        const heading = node("div", "", "sr-library-heading");
                        heading.append(node("strong", [item.name, item.version].filter(Boolean).join(" · ")),
                            node("span", outcome(item, batch.mode), item.status === "failed" ? "sr-batch-error" : "muted"));
                        row.append(heading);
                        if (item.error) row.append(node("p", detail(item.error, "The operation failed."), "sr-batch-error"));
                        if (item.outputFile) row.append(node("small", item.outputFile, "muted"));
                        list.append(row);
                    }
                    if (active) timer = setTimeout(load, 1000);
                    else if (batch.mode === "install") void refresh?.();
                } catch (error) {
                    if (!dialog.open || current !== cycle) return;
                    status.textContent = detail(error, "Could not check this batch.");
                    reload.hidden = false;
                }
            }
            status.textContent = "Loading batch…";
            void load();
        }

        async function history(refresh) {
            const view = panel("IPA Batches");
            if (!view) return;
            const { dialog, content, status } = view;
            status.textContent = "Loading batches…";
            try {
                const batches = await request("ipa_batches");
                if (!dialog.open) return;
                status.textContent = batches.length ? "" : "No IPA batches yet.";
                for (const batch of batches) {
                    const row = node("div", "", "sr-library-heading sr-batch-item");
                    const label = node("div");
                    const date = new Date(batch.createdAt * 1000).toLocaleString();
                    label.append(node("strong", `${batch.mode === "sign" ? "Sign" : "Install"} · ${batch.deviceName}`),
                        node("p", `${date} · ${batch.succeeded} of ${batch.total} complete`, "muted"));
                    row.append(label, button("View Batch…", () => {
                        dialog.close();
                        show(batch.id, refresh);
                    }));
                    content.append(row);
                }
            } catch (error) {
                status.textContent = detail(error, "Could not load batches.");
            }
        }

        return { review, history };
    }

    globalThis.sideRelayBatchController = controller;
})();
