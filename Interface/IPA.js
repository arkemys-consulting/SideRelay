(() => {
    if (location.origin !== "http://127.0.0.1:18784") return;

    const messages = new WeakMap();
    let importEnAttente;

    const appareil = () => /^\/devices\/[^/]+\/?$/.test(location.pathname);
    const entreeIPA = () => document.querySelector('input[type="file"][accept=".ipa"]');
    const enLecture = entree => entree?.closest("label")?.querySelector("small")?.textContent.startsWith("Reading ");

    function message(zone) {
        const texte = document.createElement("span");
        texte.className = "sr-ipa-message";
        texte.setAttribute("role", "status");
        zone.append(texte);
        messages.set(zone, texte);
        return texte;
    }

    function destinationIPA() {
        const label = document.createElement("label");
        label.className = "form-field sr-ipa-destination";
        const select = document.createElement("select");
        select.name = "ipa-destination";
        select.append(new Option("Install as a Separate App", "native"), new Option("Import into LiveContainer", "livecontainer"));
        label.append("Destination", select);
        return { label, select };
    }

    async function setupCompanion(deviceID, { onDone, dialogParent } = {}) {
        if (document.querySelector(".sr-companion-dialog[open]")) return;
        const dialog = document.createElement("dialog");
        dialog.className = "sr-certificate-review sr-companion-dialog";
        const title = document.createElement("h2");
        title.id = "sr-companion-title";
        title.textContent = "SideRelay for iPhone";
        dialog.setAttribute("aria-labelledby", title.id);
        const description = document.createElement("p");
        description.textContent = "Installs SideRelay and sets up LiveContainer signing. Uses one app slot on this iPhone.";
        const fields = document.createElement("div");
        fields.className = "sr-package-targets";
        function picker(label) {
            const field = document.createElement("label");
            field.className = "form-field";
            const select = document.createElement("select");
            field.append(label, select);
            fields.append(field);
            return select;
        }
        const phone = picker("iPhone or iPad");
        const account = picker("Apple Account");
        const status = document.createElement("p");
        status.className = "sr-app-action-status";
        status.setAttribute("role", "status");
        const actions = document.createElement("div");
        actions.className = "sr-actions";
        const close = document.createElement("button");
        close.type = "button";
        close.className = "btn btn-secondary";
        close.textContent = "Cancel";
        const install = document.createElement("button");
        install.type = "button";
        install.className = "btn btn-primary";
        install.textContent = "Install SideRelay";
        install.disabled = true;
        actions.append(close, install);
        let busy = false;
        let finished = false;
        let apps = [];
        const selectedHost = () => apps.find(app => app.deviceID === phone.value && app.installedAt &&
            /^com\.kdt\.livecontainer(?:\.[a-z0-9-]+)?$/i.test(app.bundleID || ""));
        function update() {
            const host = selectedHost();
            if (host?.accountID) account.value = host.accountID;
            account.disabled = busy || finished || Boolean(host?.accountID);
            install.textContent = host ? "Check & Install Update" : "Install SideRelay";
            install.disabled = busy || finished || !phone.value || !account.value;
        }
        phone.addEventListener("change", update);
        account.addEventListener("change", update);
        close.addEventListener("click", event => { if (event.isTrusted) dialog.close(); });
        dialog.addEventListener("close", () => dialog.remove(), { once: true });
        dialog.append(title, description, fields, status, actions);
        (dialogParent || document.body).append(dialog);
        dialog.showModal();
        status.textContent = "Loading iPhones and Apple Accounts…";
        const liveBridge = window.webkit.messageHandlers.signatureCompte;
        try {
            const [devices, accounts, catalogue] = await Promise.all([
                requete("list_devices"), requete("list_accounts"), globalThis.sideRelayCatalogue.installedApps(),
            ]);
            if (!dialog.open) return;
            apps = catalogue;
            phone.append(new Option("Choose a device…", ""), ...devices.map(device => new Option(device.name, device.id)));
            account.append(new Option("Choose an Apple Account…", ""), ...accounts.map(item => new Option(item.apple_id, item.id)));
            phone.value = deviceID || (devices.length === 1 ? devices[0].id : "");
            phone.disabled = Boolean(deviceID);
            account.value = accounts.length === 1 ? accounts[0].id : "";
            if (!devices.length || !accounts.length) {
                const link = document.createElement("a");
                link.href = !devices.length ? "/devices" : "/accounts";
                link.textContent = !devices.length ? "Pair an iPhone in Devices" : "Connect an Apple Account";
                status.replaceChildren(link);
            } else status.textContent = "";
            update();
        } catch {
            status.textContent = "Could not load iPhones and Apple Accounts.";
            return;
        }
        install.addEventListener("click", async event => {
            if (!event.isTrusted || install.disabled) return;
            busy = true;
            phone.disabled = true;
            update();
            status.textContent = "Checking the latest official LiveContainer release and preparing the iPhone app…";
            try {
                const item = await liveBridge.postMessage({ action: "prepareCompanion", deviceId: phone.value, accountId: account.value });
                if (!dialog.open) return;
                if (item.error) throw new Error(item.error);
                if (item.upToDate) {
                    await liveBridge.postMessage({ action: "enableCompanion" }).catch(() => null);
                    await finishSetup();
                    return;
                }
                close.textContent = "Close";
                const job = await requete("install_library_ipa", {
                    package_id: item.id, device_id: phone.value, account_id: account.value, target_app_id: item.targetAppId || "",
                }, AbortSignal.timeout(120000));
                const relay = await liveBridge.postMessage({ action: "enableCompanion" }).catch(() => null);
                if (!dialog.open) return;
                status.textContent = "Waiting for installation…";
                const result = await suivreJob(job, () => dialog.open, () => {
                    status.textContent = `Installing SideRelay with LiveContainer ${item.version || ""}…`;
                });
                if (!dialog.open) return;
                if (result?.status === "done") {
                    await finishSetup();
                    if (finished && !relay?.enabled) status.textContent += " Connect Tailscale to use the Apps tab on the iPhone.";
                } else if (result?.status === "failed") {
                    status.textContent = messageErreur(result.error, "Installation failed. See Activity for details.");
                } else {
                    finished = true;
                    status.textContent = "Installation is still running. Check Activity for the result.";
                    close.textContent = "Done";
                }
            } catch (error) {
                status.textContent = messageErreur(error.message, globalThis.sideRelayCatalogue.readableError(error, "Could not install SideRelay."));
            } finally {
                busy = false;
                if (!finished) close.textContent = "Cancel";
                phone.disabled = Boolean(deviceID) || finished;
                update();
            }
        });

        async function finishSetup() {
            status.textContent = "Setting up LiveContainer signing on the iPhone…";
            const result = await liveBridge.postMessage({ action: "configureLiveContainer", deviceId: phone.value });
            if (!dialog.open) return;
            if (!result.ready) {
                status.textContent = result.error || "LiveContainer setup is still pending. Unlock your iPhone and try again.";
                return;
            }
            finished = true;
            close.textContent = "Done";
            status.textContent = "LiveContainer is ready to import and open apps.";
            onDone?.();
        }
    }

    function transfertLiveContainer({ fichier, paquet, format, appareil, actif, onLiveLink }) {
        const bloc = document.createElement("div");
        bloc.className = "sr-livecontainer-transfer";
        bloc.hidden = true;
        const etiquette = document.createElement("label");
        etiquette.className = "form-field";
        const cible = document.createElement("select");
        etiquette.append("iPhone or iPad", cible);
        etiquette.hidden = Boolean(appareil);
        const bouton = document.createElement("button");
        bouton.type = "button";
        bouton.className = "btn btn-primary";
        bouton.textContent = "Import into LiveContainer";
        const installer = document.createElement("button");
        installer.type = "button";
        installer.className = "btn btn-secondary";
        installer.textContent = "Set Up SideRelay on iPhone…";
        installer.hidden = true;
        const fermer = document.createElement("button");
        fermer.type = "button";
        fermer.className = "btn btn-secondary";
        fermer.textContent = "Close Link";
        fermer.hidden = true;
        const qr = document.createElement("img");
        qr.alt = "Scan on the iPhone to open the private import link";
        qr.hidden = true;
        const statut = message(bloc);
        const aide = document.createElement("details");
        aide.className = "sr-livecontainer-help";
        const titreAide = document.createElement("summary");
        titreAide.textContent = "Home Screen shortcut and return to SideRelay";
        const instructions = document.createElement("p");
        instructions.textContent = "To return to SideRelay, go to the Home Screen and reopen SideRelay, or swipe down with two fingers. To add Home Screen shortcuts, tap the + next to Run or touch and hold the app and choose Add to Home Screen. Then install the downloaded profile in Settings.";
        aide.append(titreAide, instructions);
        const limite = document.createElement("p");
        limite.className = "sr-livecontainer-limit";
        limite.textContent = "The app runs inside SideRelay. You can add a Home Screen shortcut on the iPhone.";
        bloc.prepend(etiquette, limite, bouton, installer, fermer, qr);
        bloc.append(aide);
        let lienActif = false;
        let chargement = 0;
        let expiration;
        let archiveFichier;
        let archiveImportee;
        let compagnonNecessaire;
        let importEnAttente = false;
        let transfertEnCours = false;
        const destination = () => appareil || cible.value;
        const bridge = window.webkit.messageHandlers.signatureCompte;

        function compatible() {
            const plateformes = format?.()?.platforms;
            return !Array.isArray(plateformes) || !plateformes.length || plateformes.includes("iPhoneOS");
        }
        function actualiserBouton() {
            bouton.disabled = transfertEnCours || lienActif || !destination() || !compatible() || compagnonNecessaire === destination();
            installer.hidden = !destination() || !compatible() || (lienActif && qr.hidden);
            installer.className = compagnonNecessaire === destination() ? "btn btn-primary" : "btn btn-secondary";
            aide.hidden = !compatible();
        }
        function effacerLien() {
            clearTimeout(expiration);
            lienActif = false;
            fermer.hidden = qr.hidden = true;
            qr.removeAttribute("src");
            actualiserBouton();
        }
        cible.addEventListener("change", () => {
            importEnAttente = false;
            statut.textContent = "";
            actualiserBouton();
        });
        installer.addEventListener("click", event => {
            if (!event.isTrusted || installer.disabled) return;
            void ouvrirConfiguration();
        });
        async function ouvrirConfiguration() {
            const iphone = destination();
            if (lienActif) {
                try { await bridge.postMessage({ action: "closeLiveContainerLink" }); }
                catch { statut.textContent = "Could not close the existing import link."; return; }
                effacerLien();
            }
            await setupCompanion(iphone, { dialogParent: bloc.closest("dialog"), onDone: () => {
                if (!bloc.isConnected || iphone !== destination()) return;
                compagnonNecessaire = undefined;
                if (importEnAttente) {
                    importEnAttente = false;
                    document.querySelector(".sr-companion-dialog[open]")?.close();
                    void demarrerImport();
                } else {
                    statut.textContent = "LiveContainer is ready. You can import this IPA.";
                }
                actualiserBouton();
            } });
        }
        fermer.addEventListener("click", async e => {
            if (!e.isTrusted) return;
            fermer.disabled = true;
            try {
                await bridge.postMessage({ action: "closeLiveContainerLink" });
                effacerLien();
                statut.textContent = "Import link closed.";
            } catch {
                statut.textContent = "Could not close the link. It expires after 5 minutes.";
            } finally {
                fermer.disabled = false;
            }
        });
        bouton.addEventListener("click", e => {
            if (!e.isTrusted || bouton.disabled) return;
            void demarrerImport();
        });
        async function demarrerImport() {
            if (transfertEnCours) return;
            transfertEnCours = true;
            let ouvrirSetup = false;
            bouton.disabled = cible.disabled = installer.disabled = true;
            actif?.(true);
            statut.textContent = "Checking LiveContainer signing and preparing the IPA…";
            try {
                const file = fichier?.();
                if (file && file !== archiveFichier) {
                    archiveImportee = await globalThis.sideRelayCatalogue.upload("import", file);
                    archiveFichier = file;
                }
                const archive = paquet?.() ?? archiveImportee;
                if (!bloc.isConnected) return;
                const resultat = await bridge.postMessage({
                    action: "importLiveContainer", packageId: archive.id, deviceId: destination(),
                });
                if (resultat.needsCompanion || resultat.needsUpdate) {
                    compagnonNecessaire = destination();
                    importEnAttente = true;
                    ouvrirSetup = true;
                    statut.textContent = resultat.needsUpdate
                        ? "Update SideRelay on this iPhone to set up LiveContainer signing. Your IPA will stay selected."
                        : "Set up SideRelay on this iPhone to import this IPA. Your selection will stay here.";
                } else if (resultat.error) {
                    statut.textContent = resultat.error;
                    if (resultat.linkInUse) {
                        lienActif = true;
                        fermer.hidden = false;
                    }
                } else if (resultat.qr) {
                    void onLiveLink?.(destination(), format?.()?.bundleId);
                    lienActif = true;
                    fermer.hidden = false;
                    if (!resultat.opened) {
                        qr.src = "data:image/png;base64," + resultat.qr;
                        qr.hidden = false;
                    }
                    statut.textContent = resultat.opened
                        ? "Import opened on the iPhone. Check LiveContainer for the result."
                        : "Scan with the iPhone Camera, then tap Open in LiveContainer. The link expires in 5 minutes.";
                    expiration = setTimeout(() => {
                        effacerLien();
                        statut.textContent = "Import link expired.";
                    }, 300000);
                } else {
                    statut.textContent = "Import canceled.";
                }
            } catch (erreur) {
                statut.textContent = globalThis.sideRelayCatalogue.readableError(erreur, "Could not prepare the IPA.");
            } finally {
                transfertEnCours = false;
                cible.disabled = installer.disabled = false;
                actif?.(false);
                actualiserBouton();
            }
            if (ouvrirSetup && bloc.isConnected) await ouvrirConfiguration();
        }
        async function actualiser() {
            const demande = ++chargement;
            actualiserBouton();
            if (lienActif) return;
            if (!compatible()) {
                statut.textContent = "LiveContainer needs an IPA built for iPhone or iPad.";
                return;
            }
            statut.textContent = "";
            if (appareil) return;
            try {
                const devices = await requete("list_devices");
                if (demande !== chargement || bloc.hidden || !bloc.isConnected) return;
                const selection = cible.value;
                cible.replaceChildren(new Option("Choose an iPhone or iPad…", ""),
                    ...devices.map(device => new Option(device.name, device.id)));
                cible.value = devices.length === 1 ? devices[0].id
                    : devices.some(device => device.id === selection) ? selection : "";
                if (!devices.length) statut.textContent = "Pair an iPhone or iPad in Devices.";
            } catch {
                if (demande === chargement && !bloc.hidden) statut.textContent = "Could not load paired devices.";
            }
            actualiserBouton();
        }
        function reinitialiser() {
            ++chargement;
            if (lienActif) void bridge.postMessage({ action: "closeLiveContainerLink" }).catch(() => {});
            cible.replaceChildren();
            archiveFichier = archiveImportee = compagnonNecessaire = undefined;
            importEnAttente = false;
            statut.textContent = "";
            effacerLien();
        }
        return { bloc, actualiser, reinitialiser };
    }

    globalThis.sideRelayIPADestination = { destinationIPA, transfertLiveContainer, setupCompanion };

    function brancherDepot(zone, deposer, statut = message(zone), survol = zone, multiple = false) {
        const fichiers = e => Array.from(e.dataTransfer?.types ?? []).includes("Files");
        zone.addEventListener("dragover", e => {
            if (!fichiers(e)) return;
            e.preventDefault();
            e.stopPropagation();
            e.dataTransfer.dropEffect = "copy";
            survol.classList.add("sr-ipa-over");
        });
        zone.addEventListener("dragleave", e => {
            if (!zone.contains(e.relatedTarget)) survol.classList.remove("sr-ipa-over");
        });
        zone.addEventListener("drop", e => {
            survol.classList.remove("sr-ipa-over");
            if (!fichiers(e)) return;
            e.preventDefault();
            e.stopPropagation();
            const transfert = e.dataTransfer;
            const fichiersDeposes = Array.from(transfert.files);
            if (!multiple && fichiersDeposes.length > 1) {
                statut.textContent = "Drop one IPA at a time.";
                return;
            }
            if (!fichiersDeposes.length || fichiersDeposes.some(fichier => !/\.ipa$/i.test(fichier.name) || !fichier.size) ||
                Array.from(transfert.items ?? []).some(item => item.webkitGetAsEntry?.()?.isDirectory)) {
                statut.textContent = "Choose one or more .ipa files.";
                return;
            }
            statut.textContent = "";
            deposer(multiple ? fichiersDeposes : fichiersDeposes[0], statut);
        });
    }

    function charger(entree, fichier, statut) {
        if (enLecture(entree)) {
            statut.textContent = "Wait for the current file to finish loading.";
            return;
        }
        try {
            const transfert = new DataTransfer();
            transfert.items.add(fichier);
            entree.files = transfert.files;
            if (!entree.files.length) throw new Error("File selection failed");
            entree.dispatchEvent(new Event("change", { bubbles: true }));
            entree.closest("label").scrollIntoView({ block: "nearest" });
        } catch {
            statut.textContent = "Could not load this IPA. Use Choose File to try again.";
        }
    }

    function installer() {
        if (!appareil()) return;
        const ouvrir = [...document.querySelectorAll(".device-mgmt-row > button")]
            .find(bouton => bouton.textContent.trim() === "Install IPA");
        const entree = entreeIPA();
        if (ouvrir) {
            const zone = ouvrir.parentElement;
            if (!messages.has(zone)) {
                const aide = document.createElement("span");
                aide.className = "sr-ipa-hint";
                aide.textContent = "or drop an IPA here";
                zone.append(aide);
                const gestion = zone.parentElement;
                gestion.dataset.deviceOptions = "false";
                const options = document.createElement("button");
                options.type = "button";
                options.className = "sr-link sr-device-options";
                options.textContent = "Device Options";
                options.setAttribute("aria-expanded", "false");
                options.addEventListener("click", () => {
                    const ouvertes = options.getAttribute("aria-expanded") !== "true";
                    options.setAttribute("aria-expanded", String(ouvertes));
                    gestion.dataset.deviceOptions = String(ouvertes);
                });
                gestion.append(options);
                brancherDepot(zone, (fichier, statut) => {
                    const champ = entreeIPA();
                    if (champ) {
                        charger(champ, fichier, statut);
                        return;
                    }
                    const importation = { zone, fichier };
                    importEnAttente = importation;
                    ouvrir.click();
                    setTimeout(() => {
                        if (importEnAttente !== importation) return;
                        importEnAttente = undefined;
                        statut.textContent = "Open Install IPA, then drop the file again.";
                    }, 1800);
                });
            }
            zone.classList.toggle("sr-ipa-launch", !entree);
            zone.querySelector(".sr-ipa-hint").hidden = Boolean(entree);
        }
        if (!entree) return;
        const champ = entree.closest("label");
        if (!messages.has(champ)) {
            champ.closest(".form-row")?.classList.add("sr-ipa-form-fields");
            champ.classList.add("sr-ipa-field");
            brancherDepot(champ, (fichier, statut) => charger(entree, fichier, statut));
            // The portal keeps its previous file while a replacement is being read.
            entree.addEventListener("click", e => {
                if (enLecture(entree)) e.preventDefault();
            });
            const carte = entree.closest(".card");
            const apercu = document.createElement("div");
            apercu.className = "sr-install-preview";
            apercu.setAttribute("aria-live", "polite");
            carte.append(apercu);
            let tentative = 0;
            let inspection = "";
            let metadata;
            const { label, select } = destinationIPA();
            const ligne = champ.closest(".sr-ipa-form-fields");
            const transfert = transfertLiveContainer({
                fichier: () => entree.files[0], format: () => metadata,
                appareil: location.pathname.split("/")[2],
                actif: enCours => { select.disabled = entree.disabled = enCours; },
            });
            label.hidden = true;
            carte.insertBefore(label, ligne?.parentElement === carte ? ligne : apercu);
            carte.append(transfert.bloc);
            function destination() {
                const live = select.value === "livecontainer";
                carte.classList.toggle("sr-device-ipa-livecontainer", live);
                const bouton = [...carte.querySelectorAll("button")].find(b => b.textContent.trim() === "Install");
                if (bouton) bouton.hidden = live;
                transfert.bloc.hidden = !live || inspection !== "ready";
                if (live && inspection === "ready") transfert.actualiser();
            }
            select.addEventListener("change", destination);
            entree.addEventListener("change", async () => {
                const fichier = entree.files[0];
                entree.title = fichier?.name ?? "";
                messages.get(champ).textContent = "";
                const demande = ++tentative;
                inspection = fichier ? "reading" : "";
                apercu.textContent = fichier ? "Checking the IPA…" : "";
                destination();
                if (!fichier) return;
                try {
                    const resultat = await globalThis.sideRelayCatalogue.upload("inspect", fichier);
                    if (demande !== tentative) return;
                    metadata = resultat;
                    inspection = "ready";
                    apercu.replaceChildren(globalThis.sideRelayCatalogue.packageDetails(metadata));
                    label.hidden = false;
                    destination();
                } catch (error) {
                    if (demande !== tentative) return;
                    inspection = "invalid";
                    apercu.textContent = globalThis.sideRelayCatalogue.readableError(error, "Could not read the IPA.");
                }
            });
            carte.addEventListener("click", e => {
                if (e.target.closest("button")?.textContent.trim() === "Install" &&
                    (select.value === "livecontainer" || enLecture(entree) || inspection !== "ready")) {
                    e.preventDefault();
                    e.stopImmediatePropagation();
                    if (select.value === "livecontainer") return;
                    messages.get(champ).textContent = inspection === "invalid"
                        ? "Choose a valid IPA." : "Wait for the file to finish loading.";
                }
            }, true);
        }
        if (importEnAttente) {
            const { zone, fichier } = importEnAttente;
            importEnAttente = undefined;
            if (zone === ouvrir?.parentElement) charger(entree, fichier, messages.get(champ));
        }
    }

    async function requete(action, valeurs = {}, signal = AbortSignal.timeout(8000)) {
        const reponse = await fetch(`/api/${action}11318273670462819093`, {
            method: "POST",
            headers: {
                Accept: "application/json",
                ...(action === "app_documents" ? { "X-SideRelay-Documents": "1" } : {}),
                ...(action === "retry_failed_usb" ? { "X-SideRelay-Recovery": "1" } : {}),
            },
            body: new URLSearchParams(valeurs),
            redirect: "error",
            signal,
        });
        if (!reponse.ok) {
            const erreur = new Error(await reponse.text());
            erreur.http = reponse.status;
            throw erreur;
        }
        return reponse.json();
    }

    async function suivreJob(job, actif, progression) {
        const fin = Date.now() + 90000;
        while (actif() && Date.now() < fin) {
            const etat = await requete("job_status", { job_id: job });
            if (!actif()) return;
            if (["done", "failed", "cancelled", "canceled"].includes(etat.status)) return etat;
            progression(etat);
            await new Promise(resolve => setTimeout(resolve, 1800));
        }
    }

    function typeErreur(texte = "") {
        if (typeof texte !== "string") return "";
        const code = /\[(certificate-limit|pairing-unreachable|install-limit|app-id-limit|apple-account|apple-connection|main-profile-verification)\]/.exec(texte);
        if (code) return code[1];
        if (texte.includes("ApplicationVerificationFailed") && /maximum number of installed apps/i.test(texte)) return "install-limit";
        if (/not enough available app ids/i.test(texte)) return "app-id-limit";
        return "";
    }

    function messageErreur(texte, secours) {
        switch (typeErreur(texte)) {
            case "certificate-limit": return "Apple refused to create a development certificate because the account limit was reached (7460).";
            case "pairing-unreachable": return "The iPhone’s Apple pairing service is unreachable. Check its connection and try again.";
            case "install-limit": return "This iPhone has no free developer app slots. Remove a development app on the iPhone, then retry.";
            case "app-id-limit": return "This Apple Account has too few App IDs available for this IPA.";
            case "apple-account": return "Apple no longer accepts this account’s sign-in. Reconnect the Apple Account.";
            case "apple-connection": return "SideRelay could not reach the Apple sign-in service. Check the Mac’s connection and try again.";
            case "main-profile-verification": return "The iPhone rejected this build signed with the main profile. Try Separate Profiles or remove the affected extensions in IPA Workshop.";
            default: return secours;
        }
    }

    globalThis.sideRelayJobs = { requete, suivreJob, typeErreur, messageErreur };
    window.dispatchEvent(new Event("siderelay:jobs-ready"));

    globalThis.sideRelayProfileChoice = ({ statusChanged }) => {
        const bloc = document.createElement("section");
        bloc.className = "sr-profile-choice sr-app-id-preview";
        bloc.hidden = true;
        const label = document.createElement("label");
        label.className = "sr-app-ipa-refresh";
        const input = document.createElement("input");
        input.type = "checkbox";
        label.append(input, "Use Main Profile");
        const detail = document.createElement("p");
        detail.className = "muted sr-profile-help";
        detail.textContent = "By default, extensions get separate profiles. With a shared profile, widgets and other extensions might not work, and iOS may reject the installation.";
        const quota = document.createElement("p");
        quota.setAttribute("role", "status");
        bloc.append(label, detail, quota);
        let pending = false, blocked = false, result, request = 0;
        function render() {
            blocked = false;
            if (result) {
                const mainNew = Number(result.rows.some(row => !row.extension && !row.registered));
                const newCount = input.checked ? mainNew : result.new;
                const savings = result.new - mainNew;
                blocked = Number.isInteger(result.available) && newCount > result.available;
                quota.textContent = `${newCount} ${newCount === 1 ? "new App ID" : "new App IDs"}` +
                    (Number.isInteger(result.available) ? ` · ${result.available} available` : "") +
                    (!label.hidden ? ` · ${input.checked ? "Saves" : "Main profile saves"} ${savings}` : "") +
                    (blocked ? " · Not enough App IDs" : "");
            }
            quota.classList.toggle("sr-app-issue", blocked);
            statusChanged?.();
        }
        input.addEventListener("change", render);
        return {
            bloc, input, quota,
            get result() { return result; }, get pending() { return pending; }, get blocked() { return blocked; },
            get selected() { return !bloc.hidden && input.checked; },
            set enabled(value) { input.disabled = !value; },
            async check(ipa, account, { reset = false } = {}) {
                const id = ++request;
                if (reset) input.checked = false;
                result = undefined;
                pending = false;
                const canReuse = ipa?.extensions?.length && !/^com\.kdt\.livecontainer(?:\.|$)/i.test(ipa.bundleId);
                bloc.hidden = !ipa?.id && !canReuse;
                label.hidden = detail.hidden = !canReuse;
                if (!canReuse) input.checked = false;
                quota.textContent = "";
                if (!account || !ipa || bloc.hidden) { render(); return; }
                const info = ipa.id ? {} : { identifiers_json: JSON.stringify({
                    ...ipa, platforms: ipa.platforms || [], extensions: ipa.extensions || [],
                }) };
                pending = true;
                quota.textContent = "Checking App IDs with Apple…";
                render();
                try {
                    const data = await requete("preview_app_ids", {
                        package_id: ipa.id || "", account_id: account, ...info,
                    }, AbortSignal.timeout(45000));
                    if (id !== request) return;
                    result = data;
                } catch (error) {
                    if (id !== request) return;
                    quota.textContent = messageErreur(error.message, "Could not check App IDs. SideRelay will check again when signing.");
                } finally {
                    if (id === request) { pending = false; render(); }
                }
            },
        };
    };

    function lireIPA(fichier) {
        return new Promise((resolve, reject) => {
            const lecteur = new FileReader();
            lecteur.onload = () => resolve(String(lecteur.result).split(",", 2)[1]);
            lecteur.onerror = lecteur.onabort = reject;
            lecteur.readAsDataURL(fichier);
        });
    }

    globalThis.sideRelayAppInstaller = (panneau, actualiser, revoirLot, optionsSetup = {}) => {
        function element(tag, texte = "", classe = "") {
            const noeud = document.createElement(tag);
            noeud.textContent = texte;
            noeud.className = classe;
            return noeud;
        }
        function lien(texte, url) {
            const noeud = element("a", texte);
            noeud.href = url;
            return noeud;
        }
        function selection(texte) {
            const etiquette = element("label", texte, "form-field");
            const champ = element("select");
            etiquette.append(champ);
            installation.append(etiquette);
            champ.addEventListener("change", actualiserBouton);
            return champ;
        }
        function options(champ, lignes, nom, invitation) {
            champ.replaceChildren(new Option(invitation, ""), ...lignes.map(ligne => new Option(ligne[nom], ligne.id)));
            if (lignes.length === 1) champ.value = lignes[0].id;
        }

        const zone = element("section", "", "sr-app-ipa");
        const entete = element("div", "", "sr-app-ipa-heading");
        const texte = element("div");
        const nomFichier = element("p", "Drop an IPA here", "sr-app-ipa-filename");
        const depot = element("p", "Drop more IPAs to build a batch", "sr-ipa-hint");
        depot.hidden = true;
        texte.append(element("h2", "Install an IPA"), nomFichier, depot);
        const choisir = element("button", "Choose IPA…", "btn btn-secondary");
        choisir.type = "button";
        const annuler = element("button", "Cancel", "btn btn-secondary");
        annuler.type = "button";
        annuler.hidden = true;
        annuler.addEventListener("click", e => {
            if (!e.isTrusted || occupe) return;
            viderSelection();
            choisir.focus({ preventScroll: true });
        });
        const entree = element("input");
        entree.type = "file";
        entree.accept = ".ipa";
        entree.multiple = !optionsSetup.firstApp;
        entree.hidden = true;
        choisir.addEventListener("click", e => { if (e.isTrusted) entree.click(); });
        entree.addEventListener("change", () => {
            if (entree.files.length) ajouterFichiers(Array.from(entree.files));
            entree.value = "";
        });
        const commandes = element("div", "", "sr-actions sr-app-ipa-commands");
        commandes.append(annuler, choisir);
        entete.append(texte, commandes, entree);
        const formulaire = element("div", "", "sr-app-ipa-fields");
        formulaire.hidden = true;
        const installation = element("div", "", "sr-app-ipa-fields sr-native-ipa-fields");
        const { label: destination, select: mode } = destinationIPA();
        const transfert = transfertLiveContainer({
            fichier: () => fichier, format: () => infos, onLiveLink: optionsSetup.onLiveLink,
            actif: enCours => { choisir.disabled = annuler.disabled = mode.disabled = occupe = enCours; },
        });
        const appareil = selection("iPhone");
        const compte = selection("Apple Account");
        const apercu = element("div", "", "sr-install-preview");
        const comparaison = element("p", "", "sr-install-comparison");
        comparaison.setAttribute("role", "status");
        formulaire.append(apercu, destination, installation, transfert.bloc);
        installation.append(comparaison);
        const renouvellement = element("label", "", "sr-app-ipa-refresh");
        const conserver = element("input");
        conserver.type = "checkbox";
        conserver.checked = true;
        renouvellement.append(conserver, "Store IPA for auto-refresh");
        const installer = element("button", "Install", "btn btn-primary");
        installer.type = "button";
        installer.disabled = true;
        installer.addEventListener("click", e => { if (e.isTrusted) void installerIPA(); });
        installation.append(renouvellement, installer);
        const lot = element("div", "", "sr-app-ipa-batch");
        lot.hidden = true;
        const liste = element("ul", "", "sr-app-ipa-list");
        const revoir = element("button", "Review Batch…", "btn btn-primary");
        revoir.type = "button";
        revoir.addEventListener("click", e => { if (e.isTrusted) void ouvrirLot(); });
        lot.append(liste, revoir);
        zone.append(entete, formulaire, lot);
        const statut = message(zone);
        panneau.append(zone);
        brancherDepot(panneau, ajouterFichiers, statut, zone, !optionsSetup.firstApp);

        const selectionIPA = [];
        let fichier;
        let infos;
        let apps = [];
        let occupe = false;
        let chargement = 0;
        let inspectionsEnCours = false;
        const profil = globalThis.sideRelayProfileChoice({ statusChanged: actualiserBouton });
        installation.insertBefore(profil.bloc, renouvellement);
        let cibleProfil;
        function verifierProfil() {
            const cible = infos && globalThis.sideRelayCatalogue.comparison(infos, apps, appareil.value, compte.value).target;
            if ((cible?.id ?? null) !== cibleProfil) {
                cibleProfil = cible?.id ?? null;
                profil.input.checked = Boolean(cible?.useMainProfile);
            }
            void profil.check(infos, compte.value);
        }
        compte.addEventListener("change", verifierProfil);
        appareil.addEventListener("change", verifierProfil);
        mode.addEventListener("change", () => void destinationChangee());
        function actualiserBouton() {
            installer.disabled = occupe || !fichier || mode.value !== "native" || !appareil.value || !compte.value || profil.pending || profil.blocked;
            if (infos && !occupe && appareil.value && compte.value) {
                const avis = globalThis.sideRelayCatalogue.comparison(infos, apps, appareil.value, compte.value);
                comparaison.textContent = avis.text;
                comparaison.classList.toggle("sr-app-issue", Boolean(avis.warning));
            }
        }
        async function destinationChangee() {
            const live = mode.value === "livecontainer";
            installation.hidden = live;
            transfert.bloc.hidden = !live;
            statut.textContent = "";
            if (live) { void profil.check(null); transfert.actualiser(); return; }
            if (!fichier) return;
            const tentative = chargement;
            appareil.replaceChildren();
            compte.replaceChildren();
            comparaison.textContent = "";
            actualiserBouton();
            statut.textContent = "Loading iPhones and Apple Accounts…";
            const courant = () => tentative === chargement && mode.value === "native" && zone.isConnected;
            try {
                const [appareils, comptes, installees] = await Promise.all([
                    requete("list_devices"), requete("list_accounts"), globalThis.sideRelayCatalogue.installedApps(),
                ]);
                if (!courant()) return;
                apps = installees;
                options(appareil, appareils, "name", "Choose an iPhone…");
                options(compte, comptes, "apple_id", "Choose an Apple Account…");
                verifierProfil();
                statut.replaceChildren(
                    ...(!appareils.length ? [lien("Pair an iPhone", "/devices")] : []),
                    ...(!appareils.length && !comptes.length ? [" · "] : []),
                    ...(!comptes.length ? [lien("Connect an Apple Account", "/accounts")] : []),
                );
                actualiserBouton();
            } catch {
                if (courant()) statut.textContent = "Could not load iPhones or Apple Accounts.";
            }
        }
        function statutActivite(texte) {
            statut.replaceChildren(`${texte} `, lien("Open Activity", "/queue"));
        }

        function afficherSelection() {
            ++chargement;
            const seul = selectionIPA.length === 1 ? selectionIPA[0] : undefined;
            const premierFichier = seul?.fichier;
            fichier = undefined;
            infos = undefined;
            cibleProfil = undefined;
            void profil.check(null, "", { reset: true });
            apps = [];
            apercu.replaceChildren();
            appareil.replaceChildren();
            compte.replaceChildren();
            comparaison.textContent = "";
            comparaison.classList.remove("sr-app-issue");
            formulaire.hidden = true;
            transfert.reinitialiser();
            if (!selectionIPA.length) {
                mode.value = "native";
                conserver.checked = true;
            }
            const nombre = selectionIPA.length;
            annuler.hidden = nombre === 0;
            depot.hidden = optionsSetup.firstApp || nombre === 0;
            choisir.textContent = nombre ? "Add IPAs…" : "Choose IPA…";
            nomFichier.textContent = premierFichier?.name ?? (nombre ? `${nombre} IPAs selected` : "Drop an IPA here");
            statut.textContent = "";
            actualiserBouton();
            lot.hidden = nombre < 2;
            liste.replaceChildren();
            revoir.disabled = occupe || selectionIPA.some(item => !item.infos);
            if (!lot.hidden) {
                for (const item of selectionIPA) {
                    const ligne = element("li");
                    const nom = element("span", item.fichier.name);
                    const etat = element("small", item.erreur || (item.infos ? "" : "Checking…"));
                    const retirer = element("button", "Remove", "btn btn-secondary");
                    retirer.type = "button";
                    retirer.disabled = occupe;
                    retirer.setAttribute("aria-label", `Remove ${item.fichier.name} from batch`);
                    retirer.addEventListener("click", e => {
                        if (!e.isTrusted || occupe) return;
                        const index = selectionIPA.indexOf(item);
                        if (index < 0) return;
                        selectionIPA.splice(index, 1);
                        item.controle.abort();
                        afficherSelection();
                        const suivant = liste.children[Math.min(index, liste.children.length - 1)]?.querySelector("button");
                        (lot.hidden ? choisir : suivant ?? choisir).focus({ preventScroll: true });
                    });
                    const fichierEtEtat = element("div");
                    fichierEtEtat.append(nom);
                    if (etat.textContent) fichierEtEtat.append(etat);
                    ligne.append(fichierEtEtat, retirer);
                    liste.append(ligne);
                }
                return;
            }
            if (!seul) return;
            if (!seul.infos) {
                statut.textContent = seul.erreur || "Checking the IPA…";
                return;
            }
            fichier = seul.fichier;
            infos = seul.infos;
            apercu.replaceChildren(globalThis.sideRelayCatalogue.packageDetails(infos));
            formulaire.hidden = false;
            void destinationChangee();
        }

        function viderSelection() {
            for (const item of selectionIPA.splice(0)) item.controle.abort();
            afficherSelection();
        }

        function ajouterFichiers(fichiers) {
            if (occupe) { statut.textContent = "Wait for the current operation to finish."; return; }
            if (optionsSetup.firstApp) viderSelection();
            const ajoutes = [];
            for (const fichier of (optionsSetup.firstApp ? fichiers.slice(0, 1) : fichiers)) {
                if (selectionIPA.some(item => item.fichier.name === fichier.name &&
                    item.fichier.size === fichier.size && item.fichier.lastModified === fichier.lastModified)) continue;
                if (selectionIPA.length === 32) break;
                const item = { fichier, controle: new AbortController() };
                selectionIPA.push(item);
                ajoutes.push(item);
            }
            if (ajoutes.length) {
                afficherSelection();
                void inspecterSelection();
            }
            if (selectionIPA.length === 32) statut.textContent = "A batch can contain up to 32 IPAs.";
            else if (!ajoutes.length) statut.textContent = "This selection already contains those IPAs.";
        }

        async function inspecterSelection() {
            if (inspectionsEnCours) return;
            inspectionsEnCours = true;
            try {
                let item;
                while (zone.isConnected && (item = selectionIPA.find(ligne => !ligne.infos && !ligne.erreur))) {
                    await inspecter(item);
                }
            } finally {
                inspectionsEnCours = false;
            }
        }

        async function inspecter(item) {
            const { fichier, controle } = item;
            try {
                const signature = new Uint8Array(await fichier.slice(0, 4).arrayBuffer());
                if (controle.signal.aborted) return;
                if (!/\.ipa$/i.test(fichier.name) || signature.join() !== "80,75,3,4") {
                    throw new Error("Choose a valid .ipa file.");
                }
                item.infos = await globalThis.sideRelayCatalogue.upload("inspect", fichier, controle.signal);
            } catch (error) {
                item.erreur = globalThis.sideRelayCatalogue.readableError(error, "Could not read the IPA.");
            }
            if (selectionIPA.includes(item) && zone.isConnected) afficherSelection();
        }

        async function ouvrirLot() {
            if (occupe || revoir.disabled || selectionIPA.length < 2) return;
            const elements = [...selectionIPA];
            await revoirLot(elements.map(item => item.infos), {
                async archive(progression) {
                    const paquets = [];
                    for (const [index, item] of elements.entries()) {
                        progression(`Preparing IPA ${index + 1} of ${elements.length}…`);
                        item.paquet ??= await globalThis.sideRelayCatalogue.upload("import", item.fichier);
                        paquets.push(item.paquet);
                    }
                    progression("Queuing batch…");
                    return paquets;
                },
                onStarted() {
                    viderSelection();
                    void actualiser();
                },
            });
        }

        async function installerIPA() {
            if (installer.disabled || occupe) return;
            const profilPrincipal = profil.selected;
            occupe = true;
            profil.enabled = false;
            choisir.disabled = annuler.disabled = mode.disabled = appareil.disabled = compte.disabled = conserver.disabled = true;
            actualiserBouton();
            statut.textContent = "Reading IPA…";
            let transmis = false;
            try {
                const ipa = await lireIPA(fichier);
                if (!zone.isConnected) return;
                statut.textContent = "Queuing installation…";
                transmis = true;
                const job = await requete("install_ipa", {
                    device_id: appareil.value,
                    account_id: compte.value,
                    ipa_bytes_b64: ipa,
                    store: String(conserver.checked),
                    use_main_profile: String(profilPrincipal),
                }, AbortSignal.timeout(120000));
                if (typeof job !== "string" || !job) throw new Error("No installation job");
                await optionsSetup.onQueued?.(job);
                statutActivite("Installation queued.");
                void actualiser();
                const etat = await suivreJob(job, () => zone.isConnected, courant => {
                    statutActivite(courant.status === "running" ? "Installing…" : "Installation queued.");
                });
                if (!zone.isConnected) return;
                if (etat?.status === "done") {
                    viderSelection();
                    statut.textContent = "Installed.";
                    void actualiser();
                } else if (["failed", "cancelled", "canceled"].includes(etat?.status)) {
                    statutActivite(etat.status === "failed" ? messageErreur(etat.error, "Installation failed.") : "Installation was cancelled.");
                    void actualiser();
                } else {
                    viderSelection();
                    statutActivite("Installation is still in progress.");
                }
            } catch (erreur) {
                if (!zone.isConnected) return;
                if (erreur.http === 413) statut.textContent = "This IPA is too large for SideRelay.";
                else if (typeErreur(erreur.message) === "pairing-unreachable") statut.textContent = messageErreur(erreur.message);
                else if (transmis && erreur.http && erreur.http < 500) {
                    statutActivite(messageErreur(erreur.message, "Could not queue the installation. Check the selection and try again."));
                } else if (transmis) {
                    viderSelection();
                    statutActivite("Could not confirm the installation.");
                } else statut.textContent = "Could not read this IPA. Choose the file again.";
            } finally {
                occupe = false;
                profil.enabled = true;
                choisir.disabled = annuler.disabled = mode.disabled = appareil.disabled = compte.disabled = conserver.disabled = false;
                actualiserBouton();
            }
        }
    };

    new MutationObserver(installer).observe(document.body, { childList: true, subtree: true });
    window.addEventListener("popstate", installer);
    installer();
})();
