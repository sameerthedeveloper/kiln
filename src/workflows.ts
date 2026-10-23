export interface Workflow { name: string; desc: string; command: string }

export const WORKFLOWS: Workflow[] = [
  { name: 'Undo last git commit (keep changes)', desc: 'git', command: 'git reset --soft HEAD~1' },
  { name: 'Discard all local changes', desc: 'git', command: 'git restore . && git clean -fd' },
  { name: 'Create and switch to branch', desc: 'git', command: 'git switch -c {{branch}}' },
  { name: 'Delete merged local branches', desc: 'git', command: "git branch --merged | grep -v '\\*\\|main\\|master' | xargs -n 1 git branch -d" },
  { name: 'Pretty git log graph', desc: 'git', command: 'git log --graph --oneline --decorate --all -n {{count}}' },
  { name: 'Amend last commit message', desc: 'git', command: 'git commit --amend -m "{{message}}"' },
  { name: 'Show files changed in last commit', desc: 'git', command: 'git show --stat --oneline HEAD' },
  { name: 'Kill process on port', desc: 'process', command: 'lsof -ti tcp:{{port}} | xargs kill -9' },
  { name: 'Find process by name', desc: 'process', command: 'ps aux | grep -i {{name}} | grep -v grep' },
  { name: 'Top 10 largest files here', desc: 'disk', command: 'find . -type f -exec du -h {} + | sort -rh | head -n 10' },
  { name: 'Disk usage by folder', desc: 'disk', command: 'du -sh * | sort -rh | head -n {{count}}' },
  { name: 'Find files by name', desc: 'search', command: 'find . -iname "*{{pattern}}*" -not -path "*/node_modules/*"' },
  { name: 'Search text in files', desc: 'search', command: 'grep -rn --exclude-dir=node_modules --exclude-dir=.git "{{text}}" .' },
  { name: 'Replace text in files', desc: 'search', command: "grep -rl '{{from}}' . | xargs sed -i '' 's/{{from}}/{{to}}/g'" },
  { name: 'Extract tar.gz', desc: 'archive', command: 'tar -xzf {{file}}' },
  { name: 'Create tar.gz of folder', desc: 'archive', command: 'tar -czf {{name}}.tar.gz {{folder}}' },
  { name: 'HTTP server in current folder', desc: 'network', command: 'python3 -m http.server {{port}}' },
  { name: 'Show listening ports', desc: 'network', command: 'lsof -iTCP -sTCP:LISTEN -n -P' },
  { name: 'Public IP address', desc: 'network', command: 'curl -s https://ifconfig.me && echo' },
  { name: 'Time a HTTP request', desc: 'network', command: 'curl -o /dev/null -s -w "dns %{time_namelookup}s  total %{time_total}s\\n" {{url}}' },
  { name: 'Clear DNS cache (macOS)', desc: 'network', command: 'sudo dscacheutil -flushcache && sudo killall -HUP mDNSResponder' },
  { name: 'Docker: remove stopped containers', desc: 'docker', command: 'docker container prune -f' },
  { name: 'Docker: follow container logs', desc: 'docker', command: 'docker logs -f --tail {{count}} {{container}}' },
  { name: 'Remove node_modules and reinstall', desc: 'node', command: 'rm -rf node_modules && npm install' },
  { name: 'List global npm packages', desc: 'node', command: 'npm ls -g --depth=0' },
  { name: 'Count lines of code', desc: 'code', command: "git ls-files | xargs wc -l | sort -rn | head -n {{count}}" },
  { name: 'Generate SSH key', desc: 'ssh', command: 'ssh-keygen -t ed25519 -C "{{email}}"' },
  { name: 'Show battery status (macOS)', desc: 'system', command: 'pmset -g batt' },
];

export const paramsOf = (cmd: string) => [...new Set([...cmd.matchAll(/\{\{(\w+)\}\}/g)].map((m) => m[1]))];
export const fill = (cmd: string, v: Record<string, string>) => cmd.replace(/\{\{(\w+)\}\}/g, (_, k) => v[k] ?? '');
