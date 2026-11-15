import AppKit

@main
struct IconeSideRelay {
    @MainActor
    static func main() throws {
        let dossier = URL(fileURLWithPath: CommandLine.arguments[1], isDirectory: true)
        let symboles = URL(fileURLWithPath: CommandLine.arguments[2], isDirectory: true)
        for taille in [16, 32, 128, 256, 512] {
            for densite in 1...2 {
                let pixels = taille * densite
                guard let bitmap = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: pixels,
                    pixelsHigh: pixels, bitsPerSample: 8, samplesPerPixel: 4, hasAlpha: true,
                    isPlanar: false, colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0),
                    let contexte = NSGraphicsContext(bitmapImageRep: bitmap) else {
                    throw CocoaError(.fileWriteUnknown)
                }
                NSGraphicsContext.saveGraphicsState()
                NSGraphicsContext.current = contexte
                contexte.cgContext.clear(CGRect(x: 0, y: 0, width: pixels, height: pixels))
                dessinerSideRelay(NSRect(x: 0, y: 0, width: pixels, height: pixels), modele: false)
                NSGraphicsContext.restoreGraphicsState()
                let suffixe = densite == 2 ? "@2x" : ""
                guard let png = bitmap.representation(using: .png, properties: [:]) else {
                    throw CocoaError(.fileWriteUnknown)
                }
                try png.write(to: dossier.appendingPathComponent("icon_\(taille)x\(taille)\(suffixe).png"))
            }
        }
        for (nom, symbole) in [
            ("DASHBOARD", "house"),
            ("DEVICES", "iphone"),
            ("APPS", "square.grid.2x2"),
            ("STORE", "storefront"),
            ("SEARCH", "magnifyingglass"),
            ("ACCOUNTS", "person.crop.circle"),
            ("CERTIFICATE", "person.text.rectangle"),
            ("QUEUE", "list.bullet.rectangle"),
            ("SETTINGS", "gearshape"),
        ] {
            guard let image = NSImage(systemSymbolName: symbole, accessibilityDescription: nil)?
                .withSymbolConfiguration(.init(pointSize: 28, weight: .regular)),
                  let bitmap = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: 40, pixelsHigh: 40,
                    bitsPerSample: 8, samplesPerPixel: 4, hasAlpha: true, isPlanar: false,
                    colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0),
                  let contexte = NSGraphicsContext(bitmapImageRep: bitmap) else {
                throw CocoaError(.fileWriteUnknown)
            }
            NSGraphicsContext.saveGraphicsState()
            NSGraphicsContext.current = contexte
            contexte.cgContext.clear(CGRect(x: 0, y: 0, width: 40, height: 40))
            let taille = image.size
            image.draw(in: NSRect(x: (40 - taille.width) / 2, y: (40 - taille.height) / 2,
                                  width: taille.width, height: taille.height))
            NSGraphicsContext.restoreGraphicsState()
            guard let png = bitmap.representation(using: .png, properties: [:]) else {
                throw CocoaError(.fileWriteUnknown)
            }
            try png.write(to: symboles.appendingPathComponent(nom + ".png"))
        }
    }
}
