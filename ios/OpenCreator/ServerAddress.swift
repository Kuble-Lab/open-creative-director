import Foundation

enum ServerAddress {
    static func parse(_ input: String) -> URL? {
        let address = input.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !address.contains(where: { $0.isWhitespace || $0 == "\\" }),
              let parts = URLComponents(string: address),
              parts.scheme?.lowercased() == "https",
              let host = parts.host, !host.isEmpty,
              parts.user == nil, parts.password == nil,
              parts.query == nil, parts.fragment == nil,
              parts.port.map({ (1...65535).contains($0) }) ?? true
        else { return nil }
        return parts.url
    }
}
