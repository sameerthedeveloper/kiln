use portable_pty::{native_pty_system, Child, CommandBuilder, MasterPty, PtySize};
use serde::Serialize;
use std::{
    collections::HashMap,
    fs,
    io::{Read, Write},
    path::{Path, PathBuf},
    process::Command,
    sync::{
        atomic::{AtomicU32, Ordering},
        Mutex,
    },
};
use tauri::{
    ipc::{Channel, InvokeResponseBody},
    menu::{Menu, SubmenuBuilder},
    AppHandle, Emitter, Manager, State,
};

struct Session {
    master: Box<dyn MasterPty + Send>,
    writer: Box<dyn Write + Send>,
    child: Box<dyn Child + Send + Sync>,
}

#[derive(Default)]
struct Sessions {
    map: Mutex<HashMap<u32, Session>>,
    next: AtomicU32,
}

fn shell_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?
        .join("shell");
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    for (name, body) in [
        (".zshenv", include_str!("../shell/zshenv")),
        (".zprofile", include_str!("../shell/zprofile")),
        (".zshrc", include_str!("../shell/zshrc")),
        ("bashrc", include_str!("../shell/bashrc")),
    ] {
        fs::write(dir.join(name), body).map_err(|e| e.to_string())?;
    }
    Ok(dir)
}

fn home_var() -> Option<std::ffi::OsString> {
    std::env::var_os("HOME").or_else(|| std::env::var_os("USERPROFILE"))
}

fn expand_home(p: &str) -> PathBuf {
    if p == "~" || p.starts_with("~/") {
        if let Some(home) = home_var() {
            return PathBuf::from(home).join(p.trim_start_matches('~').trim_start_matches('/'));
        }
    }
    PathBuf::from(p)
}

#[tauri::command]
fn pty_spawn(
    app: AppHandle,
    state: State<Sessions>,
    cols: u16,
    rows: u16,
    cwd: Option<String>,
    on_data: Channel<InvokeResponseBody>,
) -> Result<u32, String> {
    let pair = native_pty_system()
        .openpty(PtySize { rows, cols, pixel_width: 0, pixel_height: 0 })
        .map_err(|e| e.to_string())?;

    let default_shell = if cfg!(windows) { "powershell.exe" } else { "/bin/zsh" };
    let shell = std::env::var("SHELL").unwrap_or_else(|_| default_shell.into());
    let name = Path::new(&shell)
        .file_name()
        .and_then(|s| s.to_str())
        .unwrap_or("")
        .to_string();
    let dir = shell_dir(&app)?;

    let mut cmd = CommandBuilder::new(&shell);
    match name.as_str() {
        "zsh" => {
            cmd.args(["-l", "-i"]);
            let user_zd = std::env::var("ZDOTDIR")
                .unwrap_or_else(|_| std::env::var("HOME").unwrap_or_default());
            cmd.env("KILN_USER_ZDOTDIR", user_zd);
            cmd.env("ZDOTDIR", &dir);
        }
        "bash" => {
            cmd.arg("--rcfile");
            cmd.arg(dir.join("bashrc"));
            cmd.arg("-i");
        }
        "powershell.exe" | "pwsh.exe" | "powershell" | "pwsh" => {
            cmd.arg("-NoLogo");
        }
        "cmd.exe" => {}
        _ => {
            cmd.args(["-l", "-i"]);
        }
    }
    cmd.env("TERM", "xterm-256color");
    cmd.env("COLORTERM", "truecolor");
    cmd.env("TERM_PROGRAM", "Kiln");
    cmd.env("TERM_PROGRAM_VERSION", env!("CARGO_PKG_VERSION"));
    if std::env::var_os("LANG").is_none() {
        cmd.env("LANG", "en_US.UTF-8");
    }
    let start = cwd
        .as_deref()
        .map(expand_home)
        .filter(|p| p.is_dir())
        .or_else(|| home_var().map(PathBuf::from));
    if let Some(p) = start {
        cmd.cwd(p);
    }

    let child = pair.slave.spawn_command(cmd).map_err(|e| e.to_string())?;
    drop(pair.slave);
    let mut reader = pair.master.try_clone_reader().map_err(|e| e.to_string())?;
    let writer = pair.master.take_writer().map_err(|e| e.to_string())?;

    let id = state.next.fetch_add(1, Ordering::SeqCst) + 1;
    state.map.lock().unwrap().insert(
        id,
        Session { master: pair.master, writer, child },
    );

    std::thread::spawn(move || {
        let mut buf = [0u8; 32 * 1024];
        loop {
            match reader.read(&mut buf) {
                Ok(0) | Err(_) => break,
                Ok(n) => {
                    if on_data.send(InvokeResponseBody::Raw(buf[..n].to_vec())).is_err() {
                        break;
                    }
                }
            }
        }
        let _ = app.emit("pty-exit", id);
    });
    Ok(id)
}

#[tauri::command]
fn pty_write(state: State<Sessions>, id: u32, data: String) {
    if let Some(s) = state.map.lock().unwrap().get_mut(&id) {
        let _ = s.writer.write_all(data.as_bytes());
        let _ = s.writer.flush();
    }
}

#[tauri::command]
fn pty_resize(state: State<Sessions>, id: u32, cols: u16, rows: u16) {
    if let Some(s) = state.map.lock().unwrap().get(&id) {
        let _ = s.master.resize(PtySize { rows, cols, pixel_width: 0, pixel_height: 0 });
    }
}

#[tauri::command]
fn pty_kill(state: State<Sessions>, id: u32) {
    if let Some(mut s) = state.map.lock().unwrap().remove(&id) {
        let _ = s.child.kill();
    }
}

#[derive(Serialize)]
struct Completion {
    name: String,
    dir: bool,
}

fn complete_in_dir(cwd: &str, token: &str) -> Vec<Completion> {
    let (dir_part, prefix) = match token.rfind('/') {
        Some(i) => (&token[..=i], &token[i + 1..]),
        None => ("", token),
    };
    let base = if dir_part.is_empty() {
        expand_home(cwd)
    } else {
        let d = expand_home(dir_part);
        if d.is_absolute() { d } else { expand_home(cwd).join(d) }
    };
    let show_hidden = prefix.starts_with('.');
    let mut out: Vec<Completion> = fs::read_dir(base)
        .into_iter()
        .flatten()
        .flatten()
        .filter_map(|e| {
            let name = e.file_name().to_string_lossy().to_string();
            if !name.starts_with(prefix) || (!show_hidden && name.starts_with('.')) {
                return None;
            }
            let dir = e.path().is_dir();
            Some(Completion { name: format!("{dir_part}{name}"), dir })
        })
        .collect();
    out.sort_by(|a, b| b.dir.cmp(&a.dir).then(a.name.to_lowercase().cmp(&b.name.to_lowercase())));
    out.truncate(200);
    out
}

fn complete_commands(prefix: &str) -> Vec<Completion> {
    let mut seen = std::collections::BTreeSet::new();
    if let Some(path) = std::env::var_os("PATH") {
        for dir in std::env::split_paths(&path) {
            for e in fs::read_dir(dir).into_iter().flatten().flatten() {
                let name = e.file_name().to_string_lossy().to_string();
                if name.starts_with(prefix) {
                    seen.insert(name);
                }
            }
        }
    }
    seen.into_iter().take(200).map(|name| Completion { name, dir: false }).collect()
}

#[tauri::command]
fn complete(cwd: String, token: String, first: bool) -> Vec<Completion> {
    if first && !token.contains('/') && !token.starts_with('~') && !token.starts_with('.') {
        return complete_commands(&token);
    }
    complete_in_dir(&cwd, &token)
}

#[derive(Serialize)]
struct GitInfo {
    branch: String,
    dirty: usize,
}

#[tauri::command]
fn git_info(cwd: String) -> Option<GitInfo> {
    let dir = expand_home(&cwd);
    let run = |args: &[&str]| {
        Command::new("git")
            .arg("-C")
            .arg(&dir)
            .args(args)
            .env("GIT_OPTIONAL_LOCKS", "0")
            .output()
            .ok()
            .filter(|o| o.status.success())
            .map(|o| String::from_utf8_lossy(&o.stdout).to_string())
    };
    let branch = run(&["rev-parse", "--abbrev-ref", "HEAD"])?.trim().to_string();
    let dirty = run(&["status", "--porcelain"]).map(|s| s.lines().count()).unwrap_or(0);
    Some(GitInfo { branch, dirty })
}

#[tauri::command]
fn read_shell_history() -> Vec<String> {
    let home = match home_var() {
        Some(h) => PathBuf::from(h),
        None => return vec![],
    };
    let text = fs::read(home.join(".zsh_history"))
        .map(|b| String::from_utf8_lossy(&b).to_string())
        .unwrap_or_default();
    let mut out: Vec<String> = Vec::new();
    for line in text.lines() {
        let cmd = match line.strip_prefix(": ") {
            Some(rest) => rest.split_once(';').map(|(_, c)| c).unwrap_or(""),
            None => line,
        };
        let cmd = cmd.trim();
        if !cmd.is_empty() && !cmd.ends_with('\\') {
            out.push(cmd.to_string());
        }
    }
    let start = out.len().saturating_sub(3000);
    out.split_off(start)
}

#[tauri::command]
fn home_dir() -> String {
    home_var().map(|h| h.to_string_lossy().into_owned()).unwrap_or_else(|| "/".into())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .manage(Sessions::default())
        .setup(|app| {
            let h = app.handle();
            let app_menu = SubmenuBuilder::new(h, "Kiln")
                .about(None)
                .separator()
                .hide()
                .hide_others()
                .separator()
                .quit()
                .build()?;
            let edit = SubmenuBuilder::new(h, "Edit")
                .undo()
                .redo()
                .separator()
                .cut()
                .copy()
                .paste()
                .select_all()
                .build()?;
            let window = SubmenuBuilder::new(h, "Window")
                .minimize()
                .fullscreen()
                .build()?;
            app.set_menu(Menu::with_items(h, &[&app_menu, &edit, &window])?)?;
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            pty_spawn,
            pty_write,
            pty_resize,
            pty_kill,
            complete,
            git_info,
            read_shell_history,
            home_dir
        ])
        .run(tauri::generate_context!())
        .expect("error while running Kiln");
}
