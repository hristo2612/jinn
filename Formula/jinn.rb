class Jinn < Formula
  desc "Lightweight AI gateway daemon orchestrating Claude Code and Codex"
  homepage "https://github.com/hristo2612/jinn"
  url "https://registry.npmjs.org/jinn-cli/-/jinn-cli-0.33.3.tgz"
  sha256 "fb1f9e471878603c286fb5fa25791cb3a1a98f4ad427dddde1f45a9681f9a5c8"
  license "MIT"

  livecheck do
    url "https://registry.npmjs.org/jinn-cli"
    regex(/"latest":\s*"(\d+(?:\.\d+)+)"/)
  end

  depends_on "node@22"
  depends_on "python" => :build

  def install
    # ignore_scripts: false is load-bearing, not cosmetic. Homebrew's
    # npm_install_security_args defaults ignore_scripts: true, which suppresses
    # every lifecycle script in the tree. Two of them matter here:
    #
    #   * better-sqlite3's `install` (prebuild-install || node-gyp rebuild).
    #     Without it no compiled addon is produced at all and the gateway dies
    #     at boot with "Could not locate the bindings file".
    #   * node-pty's `install`, which under the --build-from-source that
    #     std_npm_args already passes compiles build/Release/{pty.node,
    #     spawn-helper} with correct modes. Without it node-pty falls back to
    #     the checked-in prebuilds, whose spawn-helper ships mode 0644, and
    #     every session dies with "posix_spawnp failed.".
    #
    # depends_on "python" => :build exists to serve that compile step.
    system "npm", "install", *std_npm_args(ignore_scripts: false)
    bin.install_symlink libexec.glob("bin/*")
  end

  def caveats
    <<~EOS
      To get started, run:
        jinn setup

      Then start the gateway daemon:
        jinn start

      The web dashboard will be available at http://localhost:7777
    EOS
  end

  test do
    assert_match version.to_s, shell_output("#{bin}/jinn --version")
    assert_match "Usage", shell_output("#{bin}/jinn --help")

    cd libexec/"lib/node_modules/jinn-cli" do
      # Must OPEN a database, not just require the module. better-sqlite3
      # resolves its binding lazily inside the Database constructor, so a bare
      # require('better-sqlite3') passes even when no compiled addon exists
      # anywhere on disk -- which is exactly how a binding-less install shipped
      # undetected.
      system "node", "-e", "new (require('better-sqlite3'))(':memory:').close()"

      # Likewise require('node-pty') passes while spawn-helper is mode 0644.
      # Only a real spawn posix_spawns the helper binary.
      system "node", "-e", <<~JS
        const pty = require('node-pty');
        pty.spawn('/bin/echo', ['ok'], {}).kill();
      JS
    end
  end
end
