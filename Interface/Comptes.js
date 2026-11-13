(() => {
    const pont = window.webkit.messageHandlers.signatureCompte;
    const selecteur = "form:has(input[type=email]):has(input[type=password])";

    function ouvrirAppIDs(main, accountID) {
        if (!accountID || main.querySelector(".sr-recovery-app-ids")) return;
        const section = document.createElement("section");
        section.className = "card sr-recovery-app-ids";
        const title = document.createElement("h2");
        title.textContent = "App IDs";
        title.tabIndex = -1;
        const message = document.createElement("p");
        message.setAttribute("role", "status");
        message.textContent = "Checking App IDs with Apple…";
        const close = document.createElement("a");
        close.href = "/accounts";
        close.textContent = "Back to Apple Accounts";
        const list = document.createElement("ul");
        list.className = "sr-app-id-list";
        section.append(title, message, list, close);
        (main.querySelector(".page") || main).prepend(section);
        title.focus();
        const { requete, messageErreur } = globalThis.sideRelayJobs;
        Promise.all([requete("list_account_app_ids", { account_id: accountID }, AbortSignal.timeout(45000)), requete("list_accounts")]).then(([result, accounts]) => {
            if (!section.isConnected) return;
            const account = accounts.find(item => item.id === accountID);
            title.textContent = account ? `App IDs · ${account.apple_id}` : "App IDs";
            message.textContent = Number.isInteger(result.available_quantity) && result.available_quantity >= 0
                ? `${result.available_quantity} available${result.max_quantity ? ` of ${result.max_quantity}` : ""}` : "Registered App IDs";
            for (const entry of result.entries) {
                const item = document.createElement("li");
                const name = document.createElement("span");
                const identifier = document.createElement("small");
                identifier.textContent = entry.identifier;
                name.append(entry.name || entry.identifier, identifier);
                item.append(name);
                if (entry.expiration_date) {
                    const date = document.createElement("span");
                    date.textContent = `Expires ${new Intl.DateTimeFormat("en", { dateStyle: "medium" }).format(entry.expiration_date * 1000)}`;
                    item.append(date);
                }
                list.append(item);
            }
        }).catch(error => {
            message.textContent = messageErreur(error.message, "Could not check App IDs with Apple.");
            if (globalThis.sideRelayJobs.typeErreur(error.message) === "apple-account") {
                const link = document.createElement("a");
                link.href = `/accounts?reconnect=${encodeURIComponent(accountID)}`;
                link.textContent = "Reconnect Apple Account";
                message.after(link);
            }
        });
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

    function installer() {
        if (location.origin !== "http://127.0.0.1:18784" || location.pathname !== "/accounts") return;
        installerListe();
        const params = new URLSearchParams(location.search);
        const accountIDs = params.get("appIDs");
        const main = document.querySelector("main.main-content");
        if (main && accountIDs && !document.documentElement.hasAttribute("data-sr-private") && globalThis.sideRelayJobs) {
            ouvrirAppIDs(main, accountIDs);
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
        if (formulaire.querySelector("[data-signature-compte]")) return;
        const titre = formulaire.closest(".card")?.querySelector("h2");
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
    }

    new MutationObserver(installer).observe(document.body, { childList: true, subtree: true, characterData: true });
    window.addEventListener("siderelay:jobs-ready", installer);
    window.addEventListener("popstate", installer);
    installer();
})();
