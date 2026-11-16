(() => {
    if (location.origin !== "http://127.0.0.1:18784") return;
    const pont = window.webkit.messageHandlers.signatureCompte;
    const demande = (action, valeurs = {}) => pont.postMessage({ action, ...valeurs });
    const titres = ["Connect your iPhone", "Choose a wireless connection", "Connect your Apple Account", "Install your first app"];
    const chemins = ["/devices", "/", "/accounts", "/"];
    const aide = {
        tailscale: "Connect on your Tailscale network, including away from home.",
        bonjour: "Connect to your iPhone on the same local network.",
    };
    let carte, cleRendue, demandeAffichage = 0;

    const style = document.createElement("style");
    style.textContent = globalThis.sideRelayCSS;
    if (document.head) document.head.append(style);
    else {
        const attendreEntete = new MutationObserver(() => {
            if (!document.head) return;
            document.head.append(style);
            attendreEntete.disconnect();
        });
        attendreEntete.observe(document, { childList: true, subtree: true });
    }

    function element(tag, texte = "", classe = "") {
        const n = document.createElement(tag);
        if (texte) n.textContent = texte;
        if (classe) n.className = classe;
        return n;
    }

    function bouton(texte, action, classe = "sr-secondary") {
        const b = element("button", texte, classe);
        b.type = "button";
        b.addEventListener("click", evenement => {
            if (evenement.isTrusted) void action(b);
        });
        return b;
    }

    function statut() {
        const n = element("p", "", "sr-feedback");
        n.setAttribute("role", "status");
        return n;
    }

    function guideCellulaire(ouvrirLien) {
        const fragment = document.createDocumentFragment();
        fragment.append(element("p", "Check whether your iPhone responds to device management (MDM) over cellular. The test reads signing profiles. Cellular refresh via MDM is unavailable for free Apple developer accounts."));

        const etapes = element("ol", "", "sr-cellular-guide-steps");
        function etape(titre, description) {
            const ligne = element("li");
            ligne.append(element("h3", titre), element("p", description));
            etapes.append(ligne);
            return ligne;
        }

        const mac = etape("Prepare your Mac",
            "Add one iPhone in Devices. Connect the Mac and iPhone to the same Tailscale network. Start the MDM service and click Check Again.");
        const details = element("details", "", "sr-cellular-terminal");
        details.append(element("summary", "Mac setup commands"));
        const outils = element("p", "Install Python 3 and Homebrew OpenSSL 3. Put the macOS binaries ");
        outils.append(ouvrirLien("NanoMDM 0.9.0", "nanomdm"), " and ",
            ouvrirLien("SCEP 2.3.0", "scep"), " in the bin folder inside Essai-MDM, next to SideRelay.app. Name the binaries nanomdm and scepserver.");
        details.append(outils, element("p", "In Terminal, open the Essai-MDM folder and run these commands."),
            element("pre", "mkdir -m 700 -p prive\n./essai.py init\nbin/scepserver ca -init -depot prive/ca"));
        const certificats = element("p", "From ");
        certificats.append(ouvrirLien("Apple PKI", "pki"),
            ", download the Apple root and Application Integration certificates. Convert the .cer files to PEM with openssl x509 -inform DER -in FILE.cer -out FILE.pem. Combine the root PEMs in prive/apple-roots.pem and the Application Integration PEMs in prive/apple-intermediates.pem.");
        details.append(certificats, element("p", "Run ./essai.py serve. In a second Terminal window, run the command below. Keep both commands running during the test."),
            element("pre", "/Applications/Tailscale.app/Contents/MacOS/Tailscale serve --https=19443 http://127.0.0.1:18795"));
        mac.append(details);

        etape("Get an Apple Push Certificate",
            "Enter a work email and click Create Request. In the Apple Push Certificates Portal, choose Create a Certificate and upload the file signed by Fleet. Download the .pem file and choose Import Certificate… in SideRelay.");
        etape("Enroll your iPhone",
            "Scan the QR code and open it in Safari to download the profile. On your iPhone, go to Settings → General → VPN & Device Management, select the SideRelay profile and tap Install.");
        etape("Test over cellular",
            "Turn off Wi-Fi in iPhone Settings, unplug the iPhone, keep Tailscale connected and lock the screen. Click Test Connection. A reply confirms that the iPhone is reachable over cellular.");
        fragment.append(etapes, element("p", "When you’re finished, remove the SideRelay profile from the iPhone, choose Turn Off Setup in SideRelay, and stop both Terminal commands with Control-C."));
        return fragment;
    }

    function modes(mode, afficherModeActuel = false) {
        const groupe = element("fieldset", "", "sr-choices");
        groupe.setAttribute("aria-label", "iPhone connection");
        for (const choix of ["tailscale", "bonjour"]) {
            const label = element("label", "", "sr-choice");
            const input = document.createElement("input");
            input.type = "radio";
            input.name = "sideRelayConnection";
            input.value = choix;
            input.checked = mode === choix;
            const titre = element("span", "", "sr-choice-title");
            titre.append(element("strong", choix === "tailscale" ? "Tailscale" : "Bonjour"));
            if (afficherModeActuel && mode === choix) {
                titre.append(element("span", "Current mode", "sr-choice-current"));
            }
            label.append(input, titre, element("small", aide[choix]));
            groupe.append(label);
        }
        return groupe;
    }

    async function aller(etape, reporter = false) {
        await demande("setupStep", { step: String(etape), defer: reporter ? "yes" : "no" });
        const destination = etape === -1 ? "/" : chemins[etape];
        if (location.pathname === destination) afficher(true);
        else location.assign(destination);
    }

    async function changer(groupe, modeActuel) {
        const mode = groupe.querySelector("input:checked")?.value;
        if (mode && mode !== modeActuel) {
            const reponse = await demande("connection", { mode });
            if (reponse.mode !== mode) throw new Error();
        }
    }

    function renouvellementCellulaire(etat) {
        const bloc = element("div", "", "sr-cellular-setting");
        const rang = element("div", "", "sr-setting-row sr-cellular-row");
        const texte = element("div");
        texte.append(element("strong", "Cellular Refresh"),
            element("p", "Via MDM. Unavailable for free Apple developer accounts", "sr-cellular-status"));
        if (etat.cellularTestAvailable === false) {
            texte.querySelector("p").textContent += ". The experimental connection test is not included in this build.";
            rang.append(texte);
            bloc.append(rang);
            return bloc;
        }
        let actif = etat.cellularSetupEnabled === true;
        const lancer = bouton(actif ? "Manage Test…" : "Connection Test…", () => ouvrir());
        rang.append(texte, lancer);
        bloc.append(rang);

        function ouvrir() {
            if (document.querySelector(".sr-cellular-dialog[open]")) return;
            const boite = element("dialog", "", "sr-certificate-review sr-cellular-dialog");
            const titre = element("h2", "Cellular Connection Test");
            titre.id = "sr-cellular-heading";
            boite.setAttribute("aria-labelledby", titre.id);
            const corps = element("div", "", "sr-cellular-content");
            const retour = statut();
            const actions = element("div", "", "sr-actions sr-cellular-actions");
            const fermer = bouton("Done", () => boite.close());
            let minuterie, enCours = false;
            let etapeAffichee = "";
            let guideOuvert = false;
            let derniereSituation;
            boite.append(titre, corps, retour, actions);
            document.body.append(boite);
            boite.addEventListener("close", () => { clearTimeout(minuterie); boite.remove(); }, {once: true});
            boite.showModal();
            function action(texte, execution, erreur, principale = false) {
                return bouton(texte, async b => {
                    if (enCours) return;
                    enCours = b.disabled = true;
                    retour.textContent = "";
                    try { await execution(); }
                    catch { retour.textContent = erreur; }
                    finally { enCours = b.disabled = false; }
                }, principale ? "btn btn-primary" : "sr-secondary");
            }

            function afficher(situation) {
                if (!boite.open) return;
                derniereSituation = situation;
                if (guideOuvert) return;
                const etape = situation?.stage || "intro";
                const cle = [etape, situation?.hasRequest, situation?.test].join("/");
                if (cle !== etapeAffichee) {
                    etapeAffichee = cle;
                    dessiner(etape, situation);
                    if (document.activeElement === boite || !boite.contains(document.activeElement)) {
                        fermer.focus({preventScroll: true});
                    }
                }
                clearTimeout(minuterie);
                if (etape === "phone" || situation?.test === "pending") {
                    const actualiser = () => {
                        if (!boite.open) return;
                        if (enCours) minuterie = setTimeout(actualiser, 3000);
                        else void lire();
                    };
                    minuterie = setTimeout(actualiser, 3000);
                }
            }

            async function lire() {
                try { afficher(await demande("cellularStatus")); }
                catch { afficher({stage: "error"}); }
            }

            function fermerGuide() {
                guideOuvert = false;
                boite.classList.remove("sr-cellular-guide");
                titre.textContent = "Cellular Connection Test";
                etapeAffichee = "";
                afficher(derniereSituation);
                actions.querySelector(".sr-cellular-guide-button")?.focus({preventScroll: true});
            }

            function ouvrirGuide() {
                guideOuvert = true;
                clearTimeout(minuterie);
                boite.classList.add("sr-cellular-guide");
                titre.textContent = "Cellular Setup Guide";
                retour.textContent = "";
                corps.replaceChildren(guideCellulaire((libelle, source) => bouton(libelle, async () => {
                    try {
                        if (!await demande("cellularGuideLink", {source})) throw new Error();
                    } catch {
                        retour.textContent = "Could not open the documentation.";
                    }
                }, "sr-cellular-guide-link")));
                actions.replaceChildren(bouton("Back to Test", fermerGuide));
                corps.scrollTop = 0;
                titre.tabIndex = -1;
                titre.focus({preventScroll: true});
            }

            boite.addEventListener("cancel", evenement => {
                if (!guideOuvert) return;
                evenement.preventDefault();
                fermerGuide();
            });

            function dessiner(etape, situation) {
                corps.replaceChildren();
                actions.replaceChildren(fermer);
                const ajouter = (titre, description) => corps.append(element("h3", titre), element("p", description));
                const verifier = action("Check Again", async () => {
                    etapeAffichee = "";
                    await lire();
                }, "Could not read the setup status.", true);
                const guide = bouton("Open Setup Guide", ouvrirGuide, "sr-secondary sr-cellular-guide-button");

                switch (etape) {
                case "intro":
                    fermer.textContent = "Cancel";
                    ajouter("Set up your iPhone", "Check that your iPhone can respond over cellular using device management (MDM) and Tailscale.");
                    actions.append(guide, action("Continue", async () => {
                        actif = await demande("cellularEnable", {enabled: "true"});
                        lancer.textContent = "Manage Test…";
                        await lire();
                    }, "Could not save this setting.", true));
                    return;
                case "serverSetup":
                case "serverOffline":
                    ajouter(etape === "serverSetup" ? "Prepare the Mac" : "Start the service on the Mac",
                        "Follow the setup guide to run the MDM service on your Mac. Then click Check Again.");
                    actions.append(guide, verifier);
                    break;
                case "deviceMissing":
                    ajouter("Add your iPhone", "Register your iPhone in Devices, then return here to check the setup.");
                    actions.append(guide, bouton("Open Devices", () => location.assign("/devices"), "btn btn-primary"));
                    break;
                case "certificate":
                    ajouter("Get an Apple Push Certificate", "Use a request signed by Fleet to create an Apple Push Certificate for this Mac.");
                    if (situation.hasRequest) {
                        corps.append(element("p", "Upload the request in Apple’s portal, download the .pem file, then import it here."));
                        const choix = element("div", "", "sr-actions");
                        choix.append(action("Show Request File", () => demande("cellularShowRequest"), "Could not show the request file."),
                            action("Open Apple Portal", () => demande("cellularApplePortal"), "Could not open the Apple portal."));
                        corps.append(choix);
                        actions.append(action("Import Certificate…", async () => {
                            if (await demande("cellularImport")) await lire();
                        }, "Import failed. Choose the .pem from Apple for this request and check that the Mac service is running.", true));
                    } else {
                        const champ = element("label", "", "sr-cellular-field");
                        const email = element("input");
                        email.type = "email";
                        email.required = true;
                        email.maxLength = 254;
                        email.autocomplete = "off";
                        champ.append(element("span", "Work email for Fleet"), email);
                        corps.append(champ);
                        actions.append(action("Create Request", async () => {
                            if (!email.reportValidity()) return;
                            retour.textContent = "Requesting a signed file from Fleet…";
                            await demande("cellularRequest", {email: email.value.trim()});
                            retour.textContent = "";
                            await lire();
                        }, "Fleet could not sign the request. Check the work email and the Mac’s internet connection.", true));
                    }
                    break;
                case "phone": {
                    ajouter("Install the profile on your iPhone", "Connect your iPhone to Tailscale, then scan the code with Camera and open the link in Safari.");
                    const qr = element("div", "", "sr-cellular-qr");
                    const image = element("img");
                    image.alt = "QR code for the private SideRelay enrollment link";
                    image.hidden = true;
                    qr.append(image, action("Copy iPhone Link", async () => {
                        if (!await demande("cellularCopyLink")) throw new Error();
                        retour.textContent = "Copied. Open this link in Safari on your iPhone.";
                    }, "Could not copy the private enrollment link."));
                    corps.append(qr, element("p", "On your iPhone, go to Settings → General → VPN & Device Management, select the SideRelay profile and tap Install."));
                    void demande("cellularQR").then(png => {
                        image.src = `data:image/png;base64,${png}`;
                        image.hidden = false;
                    }, () => { if (boite.open) retour.textContent = "Could not load the iPhone link. Check Tailscale on the Mac."; });
                    actions.append(verifier);
                    break;
                }
                case "enrolled": {
                    const resultats = {
                        acknowledged: "The iPhone replied to the connection test.",
                        pending: "Waiting for the iPhone to reply…",
                        noReply: "The iPhone hasn’t replied. Check Tailscale and cellular data on the iPhone, then try again.",
                        rejected: "The iPhone rejected the request. Check that the SideRelay profile is still installed.",
                    };
                    ajouter("iPhone enrolled", "To test over cellular, turn off Wi‑Fi on the iPhone, unplug it, keep Tailscale connected and lock the screen.");
                    corps.append(element("p", resultats[situation.test] || "The connection test reads the signing profiles on the iPhone.", "sr-cellular-test-result"));
                    corps.lastChild.setAttribute("role", "status");
                    const tester = action("Test Connection", async () => {
                        retour.textContent = "Sending a test notification…";
                        const resultat = await demande("cellularTest");
                        retour.textContent = "";
                        afficher(resultat);
                    }, "Could not send the test. Check the Apple Push Certificate and the iPhone’s enrollment.", true);
                    tester.disabled = situation.test === "pending";
                    actions.append(tester);
                    break;
                }
                default:
                    ajouter("Could not read setup", "Check that the SideRelay files and Mac service are available.");
                    actions.append(verifier);
                }

                fermer.textContent = "Done";
                const quitter = action("Turn Off Setup", async () => {
                    if (await demande("cellularEnable", {enabled: "false"})) throw new Error();
                    actif = false;
                    lancer.textContent = "Connection Test…";
                    boite.close();
                }, "Could not turn off cellular setup.");
                quitter.classList.add("sr-cellular-stop");
                actions.prepend(quitter);
                if (["certificate", "phone", "enrolled"].includes(etape)) {
                    fermer.after(guide);
                }
                if (["phone", "enrolled"].includes(etape)) {
                    corps.append(element("p", "To end the test on the iPhone, remove the SideRelay profile in Settings → General → VPN & Device Management.", "muted"));
                }
            }

            if (actif) {
                corps.append(element("p", "Checking setup…"));
                actions.append(fermer);
                fermer.focus({preventScroll: true});
                void lire();
            } else afficher();
        }

        return bloc;
    }

    function reglagesDossierIPA() {
        const ligne = element("div", "", "sr-setting-row sr-ipa-inbox-setting");
        const description = element("div");
        const chemin = element("p", "", "muted sr-ipa-inbox-path");
        description.append(element("span", "IPA Inbox"), chemin);
        const commandes = element("div", "", "sr-actions");
        const feedback = statut();
        const choisir = bouton("Choose Folder…", () => actualiser("chooseIPAInbox"));
        choisir.setAttribute("aria-label", "Choose IPA Inbox folder");
        const reinitialiser = bouton("Use Default", () => actualiser("resetIPAInbox"));
        reinitialiser.hidden = true;
        commandes.append(reinitialiser, choisir);
        ligne.append(description, commandes);
        async function actualiser(action) {
            choisir.disabled = reinitialiser.disabled = true;
            try {
                const etat = await demande(action);
                if (etat.cancelled) return;
                if (etat.error) { feedback.textContent = etat.error; return; }
                chemin.textContent = etat.path;
                reinitialiser.hidden = !etat.isCustom;
                feedback.textContent = etat.available ? "" : "Folder unavailable. The folder is monitored again when it becomes accessible.";
            } catch {
                feedback.textContent = action === "ipaInboxSettings" ? "Could not load the IPA Inbox setting."
                    : "Could not save the IPA Inbox setting.";
            } finally { choisir.disabled = reinitialiser.disabled = false; }
        }
        void actualiser("ipaInboxSettings");
        return [ligne, feedback];
    }

    function reglages(cadre, etat) {
        const feedback = statut();
        const groupe = modes(etat.mode, true);
        const appliquer = bouton("Apply Change", async b => {
            groupe.disabled = b.disabled = true;
            feedback.textContent = "Restarting the signing service…";
            try {
                await changer(groupe, etat.mode);
                location.reload();
            } catch {
                feedback.textContent = "Could not confirm the change. Wait for any signing jobs to finish, then reopen Settings.";
                groupe.disabled = b.disabled = false;
            }
        }, "btn btn-primary sr-apply-connection");
        appliquer.hidden = true;
        groupe.addEventListener("change", () => {
            appliquer.hidden = groupe.querySelector("input:checked")?.value === etat.mode;
            feedback.textContent = "";
        });
        const dock = document.createElement("input");
        dock.type = "checkbox";
        dock.setAttribute("switch", "");
        dock.checked = etat.showInDock === true;
        const etiquetteDock = element("label", "", "sr-setting-row");
        etiquetteDock.append(element("span", "Show in Dock"), dock);
        const statutDock = statut();
        dock.addEventListener("change", async () => {
            const visible = dock.checked;
            dock.disabled = true;
            statutDock.textContent = "";
            try { dock.checked = await demande("dockVisibility", { visible: String(visible) }); }
            catch {
                dock.checked = !visible;
                statutDock.textContent = "Could not update the Dock setting.";
            } finally { dock.disabled = false; }
        });
        const expiration = document.createElement("input");
        expiration.type = "checkbox";
        expiration.setAttribute("switch", "");
        expiration.checked = etat.expiryNotifications === true;
        const etiquetteExpiration = element("label", "", "sr-setting-row");
        etiquetteExpiration.append(element("span", "Notify me when an app needs a refresh"), expiration);
        const statutExpiration = statut();
        expiration.addEventListener("change", async evenement => {
            if (!evenement.isTrusted) return;
            const active = expiration.checked;
            expiration.disabled = true;
            statutExpiration.textContent = "";
            try {
                expiration.checked = await demande("expiryNotifications", { enabled: String(active) });
                if (active && !expiration.checked) {
                    statutExpiration.textContent = "Allow SideRelay in System Settings → Notifications to enable alerts.";
                }
            } catch {
                expiration.checked = !active;
                statutExpiration.textContent = "Could not update notifications.";
            } finally { expiration.disabled = false; }
        });
        const setupStatus = statut();
        const reprendre = bouton(etat.setupDeferred ? "Resume Setup…" : "Set Up SideRelay…", async b => {
            b.disabled = true;
            try { await demande("restartSetup"); }
            catch {
                setupStatus.textContent = "Could not open setup.";
                b.disabled = false;
            }
        });
        const aPropos = element("div", "", "sr-setting-row sr-version");
        aPropos.append(element("span", "SideRelay"), element("span", `Version ${etat.version} (${etat.build})`));
        const backupStatus = statut();
        const backupRow = element("div", "", "sr-setting-row");
        const backup = bouton("Back Up or Restore…", async control => {
            control.disabled = true;
            backupStatus.textContent = "";
            try {
                const result = await demande("portableBackup");
                backupStatus.textContent = result?.error || result?.message || "";
            } catch { backupStatus.textContent = "Could not open SideRelay Backup."; }
            finally { control.disabled = false; }
        });
        backupRow.append(element("span", "Library and Settings"), backup);

        cadre.classList.add("sr-settings");
        cadre.dataset.advanced = "false";
        const avance = bouton("Advanced Settings…", b => {
            const ouvert = b.getAttribute("aria-expanded") !== "true";
            cadre.dataset.advanced = String(ouvert);
            b.setAttribute("aria-expanded", String(ouvert));
            b.textContent = ouvert ? "Hide Advanced Settings" : "Advanced Settings…";
        }, "sr-secondary sr-advanced");
        avance.setAttribute("aria-expanded", "false");
        const actions = element("div", "", "sr-actions sr-settings-actions");
        const advanced = element("details", "", "sr-settings-disclosure");
        advanced.append(element("summary", "Setup and Service"), renouvellementCellulaire(etat), actions, setupStatus);
        actions.append(reprendre, avance);
        advanced.addEventListener("toggle", () => {
            if (!advanced.open && cadre.dataset.advanced === "true") {
                cadre.dataset.advanced = "false";
                avance.setAttribute("aria-expanded", "false");
                avance.textContent = "Advanced Settings…";
            }
        });
        function section(titre, ...lignes) {
            const bloc = element("section", "", "sr-settings-section");
            const contenu = element("div", "", "sr-settings-group");
            contenu.append(...lignes);
            bloc.append(element("h2", titre), contenu);
            return bloc;
        }

        cadre.append(element("h1", "Settings"),
            section("General", etiquetteDock, statutDock, etiquetteExpiration, statutExpiration),
            section("iPhone Connection", groupe, appliquer, feedback,
                element("p", "Trusted USB takes priority when connected.", "muted sr-connection-footnote")),
            section("App Updates", ...reglagesDossierIPA()),
            section("Backup", backupRow, backupStatus),
            section("Advanced", advanced),
            aPropos);
    }

    function premiereApp(cadre, etat, feedback, finish) {
        const installation = element("div", "", "sr-first-app-install");
        const verification = element("section", "", "sr-first-app-check");
        const instructions = element("p");
        const resultat = statut();
        const ouvrir = bouton("I Opened the App", b => verifier("setupConfirmOpened", b), "btn btn-primary");
        const recontroler = bouton("Check Again", b => verifier("setupVerifyFirstApp", b));
        const tester = bouton("Test Refresh", b => renouveler(b));
        const changerIPA = bouton("Choose Another IPA…", async b => {
            try {
                if (!confirm("Stop tracking this installation in setup? Apps already installed will stay on your iPhone.")) return;
                await demande("setupResetFirstApp");
                afficher(true);
            } catch { resultat.textContent = "Could not reset the check. Try again."; }
        });
        const actions = element("div", "", "sr-actions");
        actions.append(ouvrir, recontroler, tester, changerIPA);
        verification.append(element("h2", "Check the first app"), instructions, resultat, actions);
        cadre.append(installation, verification);
        let methode = etat.firstApp?.mode;
        let etatVerifie;
        let enCours = false;
        let minuteur;
        verification.hidden = !methode;
        ouvrir.hidden = tester.hidden = true;
        finish.disabled = true;
        installation.hidden = Boolean(methode);

        function afficherEtat(info) {
            etatVerifie = info;
            ouvrir.hidden = info.state !== "installed" || info.opened;
            tester.hidden = !info.opened || !["ready", "profile"].includes(info.refresh);
            finish.dataset.verified = String(info.state === "installed" && info.opened);
            finish.disabled = finish.dataset.verified !== "true";
            if (info.state === "installed" && methode === "livecontainer") installation.hidden = true;
            if (info.state === "installed") {
                instructions.textContent = info.opened ? "Opened on iPhone: " + info.name
                    : methode === "livecontainer" ? `On your iPhone, open SideRelay, go to Apps, then tap Run next to ${info.name}.`
                    : `Open ${info.name} on your iPhone. If iOS says Untrusted Developer, go to Settings → General → VPN & Device Management and trust your developer account. If iOS asks for Developer Mode, enable it in Settings → Privacy & Security and restart.`;
                const raisons = {
                    account: "Reconnect the Apple Account before refreshing.",
                    certificate: "Review the signing certificate in Apple Accounts.",
                    ipa: "Reinstall with Store IPA for auto-refresh turned on.",
                    disabled: "Turn on Auto-Refresh in Apps after setup.",
                    profile: "The signing profile has expired or could not be read. Test a refresh before relying on it.",
                    unreachable: "Unlock the iPhone and connect by USB, local Wi-Fi or Tailscale over Wi-Fi, then check again.",
                };
                resultat.textContent = info.refresh === "ready"
                    ? "Auto-Refresh ready" + (methode === "livecontainer" ? " for the SideRelay companion." : ".")
                    : "Auto-Refresh needs attention. " + (raisons[info.refresh] || "Check the signing details in Apps.");
                if (info.refresh === "ready") resultat.textContent += " Leave SideRelay running on your Mac.";
                finish.textContent = info.state === "installed" && info.opened && info.refresh !== "ready"
                    ? "Finish Without Auto-Refresh" : "Finish Setup";
            } else {
                instructions.textContent = {
                    pending: "Waiting for installation to finish…",
                    missing: "No completed installation was found. Choose another IPA to try again.",
                    failed: info.error && globalThis.sideRelayJobs
                        ? globalThis.sideRelayJobs.messageErreur(info.error, "Installation failed. Open Activity for details.")
                        : "Installation failed. Open Activity after setup to see the error, or choose another IPA to retry.",
                    companion: "Set up SideRelay on your iPhone, then import the IPA.",
                    notImported: "Finish importing the IPA on your iPhone, then click Check Again.",
                    unreadable: "Could not read LiveContainer on the iPhone. Connect and unlock it by USB with Xcode available, then check again.",
                }[info.state] || "Choose an IPA to begin.";
                resultat.textContent = "";
            }
        }

        async function verifier(action = "setupVerifyFirstApp", boutonActif) {
            if (!methode || enCours || !cadre.isConnected) return;
            clearTimeout(minuteur);
            enCours = true;
            if (boutonActif) {
                boutonActif.disabled = true;
                resultat.textContent = action === "setupConfirmOpened" ? "Confirming…" : "Checking…";
            }
            try {
                const info = await demande(action);
                if (!cadre.isConnected) return;
                afficherEtat(info);
                if (info.state === "pending") minuteur = setTimeout(() => void verifier(), 2000);
                return info;
            } catch {
                resultat.textContent = "Could not check the first app. Try again.";
            } finally {
                enCours = false;
                if (boutonActif) boutonActif.disabled = false;
            }
        }

        async function renouveler(b) {
            if (!etatVerifie?.appID || enCours) return;
            const { requete, suivreJob, messageErreur } = globalThis.sideRelayJobs;
            b.disabled = true;
            recontroler.disabled = true;
            changerIPA.disabled = true;
            finish.disabled = true;
            resultat.textContent = "Testing refresh…";
            enCours = true;
            try {
                const id = await requete("refresh_app", { app_id: etatVerifie.appID });
                const job = await suivreJob(id, () => cadre.isConnected, () => {});
                enCours = false;
                if (!cadre.isConnected) return;
                if (job?.status === "done") {
                    await verifier();
                    if (etatVerifie?.refresh === "ready") resultat.textContent = "Auto-Refresh ready. Test refresh succeeded.";
                } else {
                    resultat.textContent = messageErreur(job?.error, job ? "The test refresh did not complete." : "Refresh is still running. Check again shortly.");
                }
            } catch (error) {
                resultat.textContent = messageErreur(error.message, "Could not start the test refresh.");
            } finally {
                enCours = false;
                b.disabled = recontroler.disabled = changerIPA.disabled = false;
                finish.disabled = finish.dataset.verified !== "true";
            }
        }

        function monter() {
            if (!cadre.isConnected) return;
            if (!globalThis.sideRelayAppInstaller || !globalThis.sideRelayCatalogue || !globalThis.sideRelayProfileChoice) {
                setTimeout(monter, 100);
                return;
            }
            globalThis.sideRelayAppInstaller(installation, () => verifier(), null, {
                firstApp: true,
                onQueued: (id) => suivre("native", id),
                onLiveLink: (id, bundle) => suivre("livecontainer", id, bundle),
            });
        }
        async function suivre(mode, id, bundle) {
            try {
                await demande("setupFirstApp", { mode, id, ...(bundle ? { bundle } : {}) });
                methode = mode;
                const importVisible = mode === "livecontainer";
                installation.hidden = !importVisible;
                verification.hidden = false;
                if (importVisible) {
                    instructions.textContent = "Finish the import on your iPhone, then click Check Again.";
                    resultat.textContent = "";
                } else void verifier();
            } catch {
                feedback.textContent = "Could not save this installation for setup. Keep this window open and check Activity before trying again.";
            }
        }
        setTimeout(() => {
            monter();
            if (methode) void verifier();
        }, 0);
    }

    function guide(cadre, etat) {
        const etape = etat.step;
        cadre.classList.add("sr-setup");
        const titre = element("h1", titres[etape]);
        titre.tabIndex = -1;
        cadre.append(element("p", `Step ${etape + 1} of 4`, "sr-step"), titre);
        const feedback = statut();
        const actions = element("div", "", "sr-actions");
        let groupe;
        if (etape === 0) {
            cadre.append(element("p", "Plug in your iPhone and unlock it. Tap Trust if asked. You can also pair over Wi-Fi."));
        } else if (etape === 1) {
            const recommande = etat.recommendedConnection || etat.mode;
            cadre.append(element("p", "USB takes priority when your iPhone is plugged in. " +
                (etat.recommendedConnection
                    ? (recommande === "tailscale" ? "Tailscale is recommended: this iPhone was paired using its Tailscale address."
                        : "Bonjour is recommended: this iPhone was paired on the local network.")
                    : "Choose the connection you want to use when it’s unplugged.")));
            groupe = modes(recommande);
            cadre.append(groupe, element("p", "If you change networks, connect both devices to the new network and check the iPhone’s address in Devices.", "muted"));
        } else if (etape === 2) {
            cadre.append(element("p", "Sign in with the Apple Account you’ll use to sign apps. If Apple asks for a verification code, enter the code shown on your trusted device."));
        } else {
            cadre.append(element("p", "Install a separate app, or run it inside LiveContainer. The LiveContainer companion requires Xcode and Tailscale to set up."),
                element("p", "A free Apple developer account can’t refresh over cellular alone.", "muted"));
        }

        async function terminer(b, nouvelEtat) {
            b.disabled = true;
            try { await aller(nouvelEtat, nouvelEtat === -1); }
            catch { feedback.textContent = "Setup could not be saved. Try again."; }
            finally { b.disabled = false; }
        }
        const suivant = bouton(etape === 3 ? "Finish Setup" : "Continue", async b => {
            b.disabled = true;
            if (groupe) groupe.disabled = true;
            try {
                const actuel = await demande("portal");
                if (etape === 3 && actuel.firstApp?.opened !== "yes") {
                    b.dataset.verified = "false";
                    feedback.textContent = "Confirm that the first app opens on your iPhone before finishing.";
                    return;
                }
                if (etape === 0 && actuel.devices < 1) {
                    feedback.textContent = "Pair an iPhone below before continuing.";
                    return;
                }
                if (etape === 2 && actuel.accounts < 1) {
                    feedback.textContent = "Connect an Apple Account below before continuing.";
                    return;
                }
                if (groupe) {
                    if (groupe.querySelector("input:checked")?.value !== actuel.mode) {
                        feedback.textContent = "Restarting the signing service…";
                    }
                    await changer(groupe, actuel.mode);
                }
                await aller(etape === 3 ? -1 : etape + 1);
            } catch {
                feedback.textContent = groupe
                    ? "Could not confirm the connection. Wait for any signing jobs to finish, then try again."
                    : "Could not check your setup. Try again.";
            } finally {
                b.disabled = etape === 3 && b.dataset.verified !== "true";
                if (groupe) groupe.disabled = false;
            }
        }, "btn btn-primary");
        if (etape === 3) premiereApp(cadre, etat, feedback, suivant);
        if (etape > 0) actions.append(bouton("Back", b => terminer(b, etape - 1)));
        actions.append(suivant);
        const bas = element("div", "", "sr-wizard-actions");
        bas.append(bouton("Finish Later", b => terminer(b, -1), "sr-link"), actions);
        cadre.append(bas, feedback);
    }

    async function afficher(force = false) {
        const navigation = document.querySelector("body > .nav");
        if (navigation && !navigation.hasAttribute("aria-label")) navigation.setAttribute("aria-label", "SideRelay");
        if (document.title !== "SideRelay") document.title = "SideRelay";
        const main = document.querySelector("main.main-content");
        const route = location.pathname;
        if (!main || (!force && cleRendue?.main === main && cleRendue.route === route)) return;
        cleRendue = { main, route };
        const racine = document.documentElement;
        carte?.remove();
        const id = ++demandeAffichage;
        if (racine.dataset.srView === "app" && route !== "/settings" && !force) return;
        if (racine.dataset.srView !== "app") delete racine.dataset.srView;
        try {
            const etat = await demande("portal");
            if (id !== demandeAffichage || route !== location.pathname) return;
            racine.dataset.srConnection = etat.mode;
            if (etat.step >= 0 && etat.step < titres.length) {
                const destination = chemins[etat.step];
                if (route !== destination || location.search) {
                    location.replace(destination);
                    return;
                }
                carte = element("section", "", "sr-panel");
                carte.setAttribute("aria-label", "SideRelay setup");
                guide(carte, etat);
                main.prepend(carte);
                racine.dataset.srView = "setup-" + etat.step;
                carte.querySelector("h1").focus({ preventScroll: true });
            } else {
                racine.dataset.srView = "app";
                if (route !== "/settings") return;
                carte = element("section", "", "sr-panel");
                carte.setAttribute("aria-label", "SideRelay settings");
                reglages(carte, etat);
                main.prepend(carte);
            }
        } catch {
            if (id !== demandeAffichage || route !== location.pathname) return;
            carte = element("section", "", "sr-panel");
            carte.append(element("h1", "SideRelay could not load"),
                element("p", "SideRelay couldn’t read its setup. Check that the signing service is running and try again."),
                bouton("Retry", () => afficher(true), "btn btn-primary"));
            main.prepend(carte);
        }
    }

    function demarrer() {
        document.head.append(style);
        const observer = new MutationObserver(() => void afficher());
        observer.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ["aria-current"] });
        window.addEventListener("popstate", () => void afficher());
        if (window.navigation) window.navigation.addEventListener("currententrychange", () => void afficher());
        void afficher();
    }

    if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", demarrer, { once: true });
    else demarrer();
})();
