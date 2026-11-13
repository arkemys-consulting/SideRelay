import AppKit

@MainActor
func dessinerSideRelay(_ rect: NSRect, modele: Bool, fondPlein: Bool = false) {
    NSGraphicsContext.saveGraphicsState()
    defer { NSGraphicsContext.restoreGraphicsState() }
    let echelle = NSAffineTransform()
    echelle.translateX(by: rect.minX, yBy: rect.minY)
    echelle.scaleX(by: rect.width / 100, yBy: rect.height / 100)
    echelle.concat()

    if modele {
        let cadrage = NSAffineTransform()
        cadrage.translateX(by: -14, yBy: -14)
        cadrage.scale(by: 1.28)
        cadrage.concat()
    } else {
        NSColor(srgbRed: 0.08, green: 0.28, blue: 0.84, alpha: 1).setFill()
        if fondPlein {
            NSBezierPath(rect: NSRect(x: 0, y: 0, width: 100, height: 100)).fill()
        } else {
            NSBezierPath(roundedRect: NSRect(x: 6, y: 6, width: 88, height: 88),
                         xRadius: 22, yRadius: 22).fill()
        }
    }

    // Two rounded strokes form the S. The upper stroke ends in a forward arrow.
    (modele ? NSColor.black : .white).setStroke()
    let haut = NSBezierPath()
    haut.move(to: NSPoint(x: 49, y: 50))
    haut.line(to: NSPoint(x: 42, y: 50))
    haut.curve(to: NSPoint(x: 42, y: 70), controlPoint1: NSPoint(x: 28, y: 50), controlPoint2: NSPoint(x: 28, y: 70))
    haut.line(to: NSPoint(x: 71, y: 70))
    haut.move(to: NSPoint(x: 62, y: 79))
    haut.line(to: NSPoint(x: 71, y: 70))
    haut.line(to: NSPoint(x: 62, y: 61))
    haut.lineWidth = modele ? 8 : 7.5
    haut.lineCapStyle = .round
    haut.lineJoinStyle = .round
    haut.stroke()

    (modele ? NSColor.black : NSColor(srgbRed: 0.64, green: 0.85, blue: 1, alpha: 1)).setStroke()
    let bas = NSBezierPath()
    bas.move(to: NSPoint(x: 52, y: 50))
    bas.line(to: NSPoint(x: 59, y: 50))
    bas.curve(to: NSPoint(x: 59, y: 30), controlPoint1: NSPoint(x: 73, y: 50), controlPoint2: NSPoint(x: 73, y: 30))
    bas.line(to: NSPoint(x: 30, y: 30))
    bas.lineWidth = modele ? 8 : 7.5
    bas.lineCapStyle = .round
    bas.stroke()
}

@MainActor
func logoSideRelay(taille: CGFloat, modele: Bool) -> NSImage {
    let taille = NSSize(width: taille, height: taille)
    let image = NSImage(size: taille, flipped: false) { rect in
        MainActor.assumeIsolated {
            dessinerSideRelay(rect, modele: modele)
        }
        return true
    }
    image.isTemplate = modele
    return image
}
