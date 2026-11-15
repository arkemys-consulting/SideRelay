(() => {
    const pont = window.webkit.messageHandlers.signatureCompte;
    const selecteur = "form:has(input[type=email]):has(input[type=password])";

    async function ouvrirAppIDs(main, selection) {
        if (!main || main.querySelector(".sr-account-app-ids")) return;
        const { requete, messageErreur, typeErreur } = globalThis.sideRelayJobs;
        const node = (tag, text, style) => {
            const element = document.createElement(tag);
            if (text) element.textContent = text;
            if (style) element.className = style;
            return element;
        };
        const button = (text, style = "btn-secondary") => {
            const element = node("button", text, "btn " + style);
            element.type = "button";
            return element;
        };
        const dialog = node("dialog", "", "sr-pair-dialog sr-account-app-ids");
        dialog.setAttribute("aria-labelledby", "sr-account-app-ids-title");
        const title = node("h2", "App IDs");
        title.id = "sr-account-app-ids-title";
        const quota = node("p", "", "muted");
        const notice = node("p", "Loading App IDs…", "muted");
        notice.setAttribute("role", "status");
        const list = node("ul", "", "sr-app-id-list");
        list.setAttribute("aria-label", "App IDs registered with Apple");
        const auto = node("input");
        auto.type = "checkbox";
        const autoLabel = node("label", "", "sr-app-id-auto");
        autoLabel.append(auto, "Automatically remove unused App IDs");
        autoLabel.hidden = true;
        const remove = button("Remove Unused…", "btn-danger");
        remove.hidden = true;
        const check = button("Check Again");
        const close = button("Done", "btn-primary");
        close.autofocus = true;
        close.addEventListener("click", () => dialog.close());
        const footer = node("div", "", "sr-app-id-actions");
        footer.append(autoLabel, remove, check, close);
        dialog.append(title, quota, notice, list, footer);
        main.append(dialog);
        dialog.addEventListener("close", () => {
            dialog.remove();
            if (new URLSearchParams(location.search).has("appIDs")) history.replaceState(history.state, "", "/accounts");
        }, { once: true });
        dialog.showModal();

        const date = new Intl.DateTimeFormat("en", { dateStyle: "medium", timeStyle: "short" });
        const labels = { "in-use": "In Use", unused: "Unused", unverified: "Unverified", expired: "Expired" };
        let account, report;
        function render(result) {
            report = result;
            const { entries, max_quantity: max, available_quantity: available, automatic } = result;
            const hasAvailable = Number.isInteger(available) && available >= 0;
            const hasQuota = hasAvailable && Number.isInteger(max) && max >= available;
            quota.textContent = hasQuota ? `${max - available} of ${max} used · ${available} available`
                : hasAvailable ? `${available} available · ${entries.length} listed by Apple`
                    : `${entries.length} registered ${entries.length === 1 ? "App ID" : "App IDs"}`;
            const now = Date.now() / 1000;
            const next = entries.filter(entry => entry.usage === "unused" && entry.expiration_date > now)
                .sort((a, b) => a.expiration_date - b.expiration_date)[0];
            const unchecked = result.unchecked_devices || [];
            const feedback = [];
            if (hasQuota) feedback.push("Apple’s 7-day quota applies across all your devices and can include separate App IDs for extensions.");
            if (result.removed?.length) feedback.push(`${result.removed.length} removed from Apple’s list.`);
            if (result.errors?.length) feedback.push(...result.errors);
            if (unchecked.length) feedback.push(`Usage could not be verified for ${unchecked.join(", ")}.`);
            if (available === 0 && next) feedback.push(`Next unused App ID expires ${date.format(next.expiration_date * 1000)}.`);
            const unlisted = hasQuota ? max - available - entries.length : 0;
            if (unlisted > 0) {
                feedback.push(`Apple lists ${entries.length} and still counts ${unlisted} more against the quota. Removed IDs can count until their original expiry.`);
            } else if (hasQuota && entries.some(entry => entry.usage === "unused")) {
                feedback.push("Apple may continue counting removed App IDs until their original expiry.");
            }
            notice.textContent = feedback.join(" ");
            list.replaceChildren(...[...entries].sort((a, b) => (a.name || a.identifier).localeCompare(b.name || b.identifier)).map(entry => {
                const row = node("li");
                const name = node("span", entry.name || entry.identifier, "sr-app-id-name");
                name.append(node("small", entry.identifier, "muted"));
                const details = node("span", labels[entry.usage] || "", "sr-app-id-details");
                if (entry.expiration_date) details.append(node("small", date.format(entry.expiration_date * 1000), "muted"));
                row.append(name, details);
                return row;
            }));
            auto.checked = Boolean(automatic);
            autoLabel.hidden = !max || !Object.hasOwn(result, "automatic");
            remove.hidden = !entries.some(entry => entry.usage === "unused");
        }

        async function load(operation = "inspect", identifiers) {
            check.disabled = true;
            remove.disabled = true;
            auto.disabled = true;
            notice.textContent = operation === "remove" ? "Removing App IDs…" : "Checking App IDs with Apple…";
            try {
                const options = { account_id: account.id, operation };
                if (identifiers) options.identifiers_json = JSON.stringify(identifiers);
                const timeout = AbortSignal.timeout(105000);
                if (operation === "inspect") {
                    const listed = await requete("list_account_app_ids", { account_id: account.id }, timeout);
                    if (!dialog.open) return;
                    render(listed);
                    notice.textContent = "Checking which App IDs are in use…";
                }
                const result = await requete("manage_app_ids", options, timeout);
                if (dialog.open) render(operation === "disable" ? { ...report, automatic: false, removed: [], errors: [] } : result);
            } catch (error) {
                if (!dialog.open) return;
                notice.textContent = error.http === 404
                    ? "Restart SideRelay to load App ID management."
                    : messageErreur(error.message, "Could not check App IDs with Apple.");
                if (typeErreur(error.message) === "apple-account" && account) {
                    const link = node("a", "Reconnect Apple Account");
                    link.href = `/accounts?reconnect=${encodeURIComponent(account.id)}`;
                    notice.append(" ", link);
                }
                auto.checked = Boolean(report?.automatic);
            } finally {
                check.disabled = !account;
                auto.disabled = false;
                remove.disabled = false;
            }
        }

        check.addEventListener("click", () => void load());
        remove.addEventListener("click", event => {
            if (!event.isTrusted) return;
            const unused = report.entries.filter(entry => entry.usage === "unused");
            const names = unused.map(entry => `${entry.name || entry.identifier}\n${entry.identifier}`).join("\n\n");
            if (unused.length && window.confirm(`Remove these App IDs from Apple?\n\n${names}`)) {
                void load("remove", unused.map(entry => entry.identifier));
            }
        });
        auto.addEventListener("change", event => {
            if (!event.isTrusted) return;
            const enabled = auto.checked;
            if (enabled && !window.confirm("Automatically remove unused App IDs after SideRelay verifies all paired devices? Apple may count removed App IDs until expiry.")) {
                auto.checked = false;
                return;
            }
            void load(enabled ? "enable" : "disable");
        });
        check.disabled = true;
        try {
            const accounts = await requete("list_accounts");
            account = accounts.find(item => item.id === selection || item.apple_id.toLowerCase() === selection.toLowerCase());
            if (!account) throw new Error("Apple Account not found.");
            if (!dialog.open) return;
            title.textContent = `App IDs · ${account.apple_id}`;
            await load();
        } catch (error) {
            if (dialog.open) notice.textContent = messageErreur(error.message, "Could not load the Apple Account.");
        }
    }

    function commandesDuCompte(cellule) {
        const [appIDs, exportCert] = cellule.querySelectorAll(":scope > button.btn-secondary");
        return {
            appIDs,
            exportCert,
            remove: cellule.querySelector("form button.btn-danger"),
        };
    }

    function installerListe() {
        const table = document.querySelector("table.table:has(td.actions)");
        if (!table) return;
        for (const ligne of table.tBodies[0]?.rows ?? []) {
            const [adresse, equipe, actions] = ligne.cells;
            actions?.querySelector("form:has(button.btn-warning)")?.remove();
            if (!actions?.classList.contains("actions") || actions.querySelector(".sr-account-menu")) continue;
            if (Object.values(commandesDuCompte(actions)).some(b => !b)) continue;

            const bouton = document.createElement("button");
            bouton.type = "button";
            bouton.className = "sr-account-menu";
            bouton.textContent = "•••";
            bouton.setAttribute("aria-label", "Account actions");
            bouton.setAttribute("aria-haspopup", "menu");
            bouton.title = "Account actions";
            bouton.addEventListener("click", async evenement => {
                if (!evenement.isTrusted || bouton.dataset.menuOpen) return;
                const cadre = bouton.getBoundingClientRect();
                const disponibles = Object.fromEntries(
                    Object.entries(commandesDuCompte(actions)).map(([nom, original]) => [
                        nom, original && !original.disabled ? "1" : "0",
                    ])
                );
                bouton.dataset.menuOpen = "true";
                try {
                    const choix = await pont.postMessage({
                        action: "accountActions", x: String(cadre.left), y: String(cadre.bottom), ...disponibles,
                    });
                    if (!actions.isConnected || !Object.hasOwn(disponibles, choix) || disponibles[choix] !== "1") return;
                    if (choix === "appIDs" && globalThis.sideRelayJobs) {
                        void ouvrirAppIDs(actions.closest("main"), adresse.textContent.trim());
                        return;
                    }
                    const original = commandesDuCompte(actions)[choix];
                    if (original && !original.disabled) original.click();
                } catch {
                    // The native menu can be retried after the local portal reconnects.
                } finally {
                    delete bouton.dataset.menuOpen;
                }
            });
            adresse.classList.add("sr-account-address");
            equipe.classList.add("sr-account-team");
            actions.classList.add("sr-account-cell");
            actions.append(bouton);
            table.classList.add("sr-account-list");
            table.setAttribute("role", "list");
            table.setAttribute("aria-label", "Connected Apple accounts");
            ligne.setAttribute("role", "listitem");
            table.tBodies[0].setAttribute("role", "presentation");
            for (const cellule of ligne.cells) cellule.setAttribute("role", "presentation");
        }
    }

    function prefillReconnect(formulaire, accountID) {
        const jobs = globalThis.sideRelayJobs;
        if (!jobs || !accountID || !formulaire || formulaire.dataset.srReconnect ||
            document.documentElement.hasAttribute("data-sr-private")) return;
        formulaire.dataset.srReconnect = "loading";
        jobs.requete("list_accounts").then(accounts => {
            const identifiant = formulaire.querySelector("input[type=email]");
            const account = accounts.find(item => item.id === accountID);
            if (!formulaire.isConnected || !account || document.documentElement.hasAttribute("data-sr-private")) return;
            formulaire.dataset.srReconnect = "ready";
            formulaire.dataset.srReconnectLogin = account.apple_id;
            if (identifiant.value) return;
            identifiant.value = account.apple_id;
            identifiant.dispatchEvent(new Event("input", { bubbles: true }));
            const titre = formulaire.closest(".card")?.querySelector("h2");
            if (titre) titre.textContent = "Reconnect Apple Account";
            formulaire.querySelector("input[type=password]").focus();
        }).catch(() => {});
    }

    function connecter(formulaire, soumettre) {
        const feedback = document.createElement("p");
        feedback.className = "sr-feedback";
        feedback.setAttribute("role", "status");
        soumettre.after(feedback);

        const dialog = document.createElement("dialog");
        dialog.className = "sr-pair-dialog";
        dialog.setAttribute("aria-labelledby", "sr-verification-title");
        dialog.innerHTML = `
            <h2 id="sr-verification-title">Verify Apple Account</h2>
            <p class="sr-feedback" role="status"></p>
            <form>
                <label class="form-field">Verification Code
                    <input type="text" inputmode="numeric" autocomplete="one-time-code" pattern="[0-9]{6}" maxlength="6" required>
                </label>
                <div class="sr-wizard-actions">
                    <button type="button" class="btn btn-secondary">Cancel</button>
                    <button type="submit" class="btn btn-primary">Verify</button>
                </div>
            </form>
            <div class="sr-actions" aria-label="Verification methods"></div>`;
        const codeForm = dialog.querySelector("form");
        const code = codeForm.querySelector("input");
        const label = codeForm.querySelector("label");
        const verifier = codeForm.querySelector("button[type=submit]");
        const cancel = codeForm.querySelector("button[type=button]");
        const methods = dialog.lastElementChild;
        const instructions = dialog.querySelector("p");
        let key, busy = false;

        function request(action, values) {
            return globalThis.sideRelayJobs.requete(action, values, AbortSignal.timeout(20000));
        }

        function method(title, action) {
            const button = document.createElement("button");
            button.type = "button";
            button.className = "btn btn-secondary btn-sm";
            button.textContent = title;
            button.addEventListener("click", () => void answer(action));
            methods.append(button);
        }

        async function advance(step) {
            const until = Date.now() + 90000;
            while (step === "Pending" && Date.now() < until) {
                step = await request("poll_login", { session_key: key });
            }
            if (step === "Complete") {
                location.replace("/accounts");
                return;
            }
            const prompt = step?.TwoFactor?.prompt;
            if (!prompt) throw new Error("Apple did not return a verification step. Try signing in again.");
            codeForm.reset();
            label.hidden = verifier.hidden = prompt.unknown;
            methods.replaceChildren();
            instructions.textContent = prompt.unknown ? "Choose how to receive your verification code."
                : prompt.sms ? "Enter the six-digit code Apple sent by SMS."
                    : "Enter the six-digit code from your trusted Apple device.";
            if (!prompt.unknown) method("Resend Code", { action: "ResendCode" });
            if (prompt.sms || prompt.unknown) method("Send to Trusted Devices", { action: "SendToDevices" });
            for (const number of prompt.numbers) {
                method(`Text ${number.number}`, { "action[SendSms]": number.id });
            }
            if (!dialog.open) {
                document.body.append(dialog);
                dialog.showModal();
            }
        }

        async function run(operation) {
            if (busy) return;
            busy = soumettre.disabled = true;
            code.disabled = verifier.disabled = cancel.disabled = true;
            for (const button of methods.children) button.disabled = true;
            if (dialog.open) instructions.textContent = "Contacting Apple…";
            else feedback.textContent = "Signing in…";
            try {
                await operation();
                feedback.textContent = "";
            } catch (error) {
                if (dialog.open) dialog.close();
                key = undefined;
                feedback.textContent = error.http && error.message.startsWith("ServerError|")
                    ? error.message.slice("ServerError|".length)
                    : error.name === "TimeoutError" ? "Apple took too long to respond. Try signing in again."
                        : "Could not complete the Apple sign-in. Try again.";
            } finally {
                busy = false;
                soumettre.disabled = dialog.open;
                code.disabled = verifier.disabled = cancel.disabled = false;
                for (const button of methods.children) button.disabled = false;
                if (dialog.open && !label.hidden) code.focus();
            }
        }

        function answer(action) {
            return run(async () => {
                const step = await request("submit_two_factor", { session_key: key, ...action });
                if (action.action === "Abort") {
                    dialog.close();
                    key = undefined;
                } else {
                    await advance(step);
                }
            });
        }

        cancel.addEventListener("click", () => void answer({ action: "Abort" }));
        dialog.addEventListener("cancel", event => {
            event.preventDefault();
            void answer({ action: "Abort" });
        });
        dialog.addEventListener("close", () => {
            codeForm.reset();
            dialog.remove();
        });
        codeForm.addEventListener("submit", event => {
            event.preventDefault();
            void answer({ "action[SubmitCode]": code.value });
        });
        formulaire.addEventListener("submit", event => {
            event.preventDefault();
            event.stopImmediatePropagation();
            if (dialog.open) return;
            const appleID = formulaire.querySelector("input[type=email]");
            const password = formulaire.querySelector("input[type=password]");
            void run(async () => {
                const login = request("begin_login", { apple_id: appleID.value.trim(), password: password.value });
                password.value = "";
                const [sessionKey, step] = await login;
                key = sessionKey;
                await advance(step);
            });
        }, { capture: true });
    }

    function installer() {
        if (location.origin !== "http://127.0.0.1:18784" || location.pathname !== "/accounts") return;
        installerListe();
        const params = new URLSearchParams(location.search);
        const accountIDs = params.get("appIDs");
        const main = document.querySelector("main.main-content");
        if (main && accountIDs && !document.documentElement.hasAttribute("data-sr-private") && globalThis.sideRelayJobs) {
            void ouvrirAppIDs(main, accountIDs);
        }
        const exportCertificat = document.querySelector('.lc-cert-export a[download="ALTCertificate.p"]');
        if (exportCertificat && !exportCertificat.dataset.signatureExport) {
            exportCertificat.dataset.signatureExport = "true";
            exportCertificat.textContent = "Save LiveContainer Certificate…";
            const importDirect = document.querySelector('.lc-cert-export a[href^="livecontainer:"]');
            if (importDirect) importDirect.style.display = "none";
            const aide = document.querySelector(".lc-cert-export p.muted");
            if (aide) aide.textContent = "Save the .p12 file, then import it in LiveContainer on your iPhone.";
            exportCertificat.addEventListener("click", evenement => {
                evenement.preventDefault();
                if (!evenement.isTrusted) return;
                const prefixe = "data:application/octet-stream;base64,";
                if (!exportCertificat.href.startsWith(prefixe)) return;
                pont.postMessage({
                    action: "certificate",
                    certificate: exportCertificat.href.slice(prefixe.length),
                }).catch(() => {});
            });
        }

        const formulaire = document.querySelector(selecteur);
        const soumettre = formulaire?.querySelector("button[type=submit]");
        if (!soumettre) return;
        prefillReconnect(formulaire, params.get("reconnect"));
        const libelle = [...soumettre.childNodes].find(n => n.nodeType === Node.TEXT_NODE && n.textContent.trim() === "Sign In");
        if (libelle) libelle.textContent = "Sign In with Apple";
        const panel = formulaire.closest(".card");
        const titre = panel?.querySelector("h2");
        if (document.documentElement.dataset.srView === "app" && document.querySelector(".sr-account-list tbody tr")
            && titre && !params.has("reconnect") && !panel.classList.contains("sr-account-connect")) {
            const toggle = document.createElement("button");
            toggle.type = "button";
            toggle.textContent = "Connect an Apple Account";
            toggle.className = "sr-device-options-disclosure";
            toggle.setAttribute("aria-expanded", "false");
            toggle.addEventListener("click", () => {
                const expanded = toggle.getAttribute("aria-expanded") === "true";
                toggle.setAttribute("aria-expanded", String(!expanded));
                if (!expanded) formulaire.querySelector("input[type=email]")?.focus();
            });
            panel.classList.add("sr-account-connect");
            titre.replaceChildren(toggle);
        }
        if (formulaire.querySelector("[data-signature-compte]")) return;
        if (titre?.textContent === "Add Apple ID") titre.textContent = "Connect an Apple Account";

        const zone = document.createElement("div");
        zone.dataset.signatureCompte = "";
        zone.className = "sr-account-actions";
        const ligne = document.createElement("div");
        ligne.className = "sr-keychain-row";
        const choix = document.createElement("input");
        choix.type = "checkbox";
        const texte = document.createElement("label");
        texte.append(choix, "Save credentials in Keychain");
        const bouton = document.createElement("button");
        bouton.type = "button";
        bouton.className = "sr-secondary";
        bouton.textContent = "Fill from Keychain";
        bouton.hidden = true;
        const statut = document.createElement("p");
        statut.className = "hint";
        statut.setAttribute("role", "status");
        ligne.append(texte, bouton);
        zone.append(ligne, statut);
        const indication = formulaire.querySelector("p.hint");
        if (indication) indication.style.display = "none";
        soumettre.before(zone);
        // Keep the Leptos submit node in its original position for hydration and updates.
        soumettre.classList.add("sr-apple-submit");

        pont.postMessage({ action: "status" }).then(reponse => {
            if (reponse.saved) bouton.hidden = false;
        }).catch(() => {});

        bouton.addEventListener("click", async evenement => {
            if (!evenement.isTrusted) return;
            try {
                const compte = await pont.postMessage({ action: "fill" });
                if (!formulaire.isConnected) return;
                const reconnectLogin = formulaire.dataset.srReconnectLogin;
                if (reconnectLogin && compte.login.toLowerCase() !== reconnectLogin.toLowerCase()) {
                    statut.textContent = "The saved credentials belong to a different Apple Account.";
                    return;
                }
                const identifiant = formulaire.querySelector("input[type=email]");
                const motDePasse = formulaire.querySelector("input[type=password]");
                identifiant.value = compte.login;
                identifiant.dispatchEvent(new Event("input", { bubbles: true }));
                motDePasse.value = compte.password;
                motDePasse.dispatchEvent(new Event("input", { bubbles: true }));
                statut.textContent = "";
                soumettre.focus();
            } catch {
                statut.textContent = "Could not read the saved account from Keychain.";
            }
        });

        formulaire.addEventListener("submit", evenement => {
            if (!evenement.isTrusted || !choix.checked || !formulaire.checkValidity()) return;
            const login = formulaire.querySelector("input[type=email]").value;
            const password = formulaire.querySelector("input[type=password]").value;
            pont.postMessage({ action: "save", login, password }).then(() => {
                bouton.hidden = false;
                statut.textContent = "Credentials saved in Keychain.";
            }).catch(() => {
                statut.textContent = "Could not save the account in Keychain.";
            });
        }, { capture: true });
        connecter(formulaire, soumettre);
    }

    new MutationObserver(installer).observe(document.body, { childList: true, subtree: true, characterData: true });
    new MutationObserver(installer).observe(document.documentElement, { attributes: true, attributeFilter: ["data-sr-view"] });
    window.addEventListener("siderelay:jobs-ready", installer);
    window.addEventListener("popstate", installer);
    installer();
})();
