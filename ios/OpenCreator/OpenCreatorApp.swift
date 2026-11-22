import SwiftUI
import SafariServices

@main
struct OpenCreatorApp: App {
    var body: some Scene {
        WindowGroup { ConnectionView() }
    }
}

private struct Workspace: Identifiable {
    let url: URL
    var id: URL { url }
}

private struct ConnectionView: View {
    @AppStorage("workspaceAddress") private var savedAddress = ""
    @State private var address = ""
    @State private var workspace: Workspace?
    @FocusState private var editing: Bool

    private var url: URL? { ServerAddress.parse(address) }

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    TextField("https://beispiel.ch", text: $address)
                        .accessibilityLabel("Serveradresse")
                        .keyboardType(.URL)
                        .textContentType(.URL)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                        .focused($editing)
                        .submitLabel(.go)
                        .onSubmit { connect() }
                    if !address.isEmpty && url == nil {
                        Text("Bitte eine gültige HTTPS-Serveradresse ohne Zugangsdaten, Suchparameter oder Sprungmarke eingeben.")
                            .foregroundStyle(.red)
                    }
                } header: {
                    Text("Serveradresse")
                } footer: {
                    Text("Die Adresse deiner Open-Creative-Director-Instanz wird auf diesem Gerät gespeichert.")
                }

                Section {
                    Button("Web-App öffnen", action: connect)
                        .buttonStyle(.borderedProminent)
                        .disabled(url == nil)
                    if !savedAddress.isEmpty {
                        Button("Adresse löschen", role: .destructive) {
                            savedAddress = ""
                            address = ""
                        }
                    }
                }
            }
            .navigationTitle("Open Creative Director")
            .navigationBarTitleDisplayMode(.inline)
            .onAppear { address = savedAddress }
            .fullScreenCover(item: $workspace) { item in
                WorkspaceBrowser(url: item.url) { workspace = nil }
                    .ignoresSafeArea()
            }
        }
    }

    private func connect() {
        guard let url else { return }
        editing = false
        savedAddress = url.absoluteString
        workspace = Workspace(url: url)
    }
}

private struct WorkspaceBrowser: UIViewControllerRepresentable {
    let url: URL
    let onClose: () -> Void

    func makeCoordinator() -> Coordinator { Coordinator(onClose: onClose) }

    func makeUIViewController(context: Context) -> SFSafariViewController {
        let browser = SFSafariViewController(url: url)
        browser.delegate = context.coordinator
        return browser
    }

    func updateUIViewController(_ controller: SFSafariViewController, context: Context) {}

    final class Coordinator: NSObject, SFSafariViewControllerDelegate {
        let onClose: () -> Void
        init(onClose: @escaping () -> Void) { self.onClose = onClose }
        func safariViewControllerDidFinish(_ controller: SFSafariViewController) { onClose() }
    }
}
