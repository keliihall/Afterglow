import AppKit

enum Brand {
    /// Brand logo (bundled SVG, loaded as NSImage — macOS renders SVG natively).
    static func logo(_ id: String) -> NSImage? {
        let name = (id == "codex") ? "openai" : "claude"
        guard let path = Bundle.main.path(forResource: name, ofType: "svg") else { return nil }
        return NSImage(contentsOfFile: path)
    }

    /// A bold "afterglow" ring drawn as a template image for the menu bar, so
    /// macOS tints it for light/dark and the selected state.
    static func statusRing(_ s: CGFloat = 18) -> NSImage {
        let img = NSImage(size: NSSize(width: s, height: s), flipped: false) { _ in
            let lw = s * 0.12
            let d = s * 0.64
            let oval = NSRect(x: (s - d) / 2, y: (s - d) / 2, width: d, height: d)
            let path = NSBezierPath(ovalIn: oval)
            path.lineWidth = lw
            NSColor.black.setStroke()
            path.stroke()
            return true
        }
        img.isTemplate = true
        return img
    }
}
