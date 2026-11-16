using System.Collections.Concurrent;

namespace DoPilot.Api.Runners;

/// <summary>
/// Connected runners and the tasks sent to them. In memory: a backend restart drops both, and runners
/// re-register on reconnect. Run a single instance until this moves to a store.
/// </summary>
public sealed class RunnerRegistry
{
    private readonly ConcurrentDictionary<string, Runner> _runners = new();
    private readonly ConcurrentDictionary<string, KoraTask> _tasks = new();

    /// <summary>A runner is identified by owner + name, so a reconnect replaces the previous connection.</summary>
    public static string RunnerId(KoraUser owner, string name) => $"{owner.Sub}:{name}";

    public Runner Register(string connectionId, KoraUser owner, RunnerRegistration registration)
    {
        var runner = new Runner(RunnerId(owner, registration.Name), connectionId, owner, registration, DateTimeOffset.UtcNow);
        _runners[runner.Id] = runner;
        return runner;
    }

    /// <summary>Removes the runner on this connection; returns it and its unfinished tasks.</summary>
    public (Runner? Runner, IReadOnlyList<KoraTask> Orphaned) Disconnect(string connectionId)
    {
        var runner = _runners.Values.FirstOrDefault(r => r.ConnectionId == connectionId);
        if (runner is null || !_runners.TryRemove(new KeyValuePair<string, Runner>(runner.Id, runner)))
            return (null, []);
        var orphaned = _tasks.Values.Where(t => t.RunnerId == runner.Id && t.IsActive).ToList();
        foreach (var task in orphaned) task.MoveTo(KoraTaskState.Failed);
        return (runner, orphaned);
    }

    public Runner? Get(string runnerId) => _runners.GetValueOrDefault(runnerId);

    public Runner? ByConnection(string connectionId) => _runners.Values.FirstOrDefault(r => r.ConnectionId == connectionId);

    public IReadOnlyList<RunnerView> List() => _runners.Values
        .OrderBy(r => r.Registration.Name)
        .Select(View)
        .ToList();

    // Task counts cover everything this backend instance has seen for the runner, across reconnects.
    private RunnerView View(Runner r)
    {
        var reg = r.Registration;
        var tasks = _tasks.Values.Where(t => t.RunnerId == r.Id).ToList();
        var active = tasks.Where(t => t.IsActive).OrderBy(t => t.CreatedAt).ToList();
        var lastActivity = tasks.Select(t => t.FinishedAt ?? t.StartedAt ?? t.CreatedAt).DefaultIfEmpty().Max();
        return new RunnerView(
            r.Id, reg.Name, reg.Machine, reg.Version, r.Owner, reg.Repos, reg.Agents, reg.Concurrency,
            active.Count, r.ConnectedAt,
            reg.Platform, reg.NodeVersion, reg.ClaudeVersion, reg.GithubAccount,
            reg.AllowBinaries ?? [], reg.DispatchAccept ?? [],
            tasks.Count(t => t.State == KoraTaskState.Succeeded),
            tasks.Count(t => t.State == KoraTaskState.Failed),
            tasks.Count == 0 ? null : lastActivity,
            active.Select(t => t.Summary()).ToList());
    }

    public KoraTask CreateTask(Runner runner, KoraUser from, string repo, string prompt)
    {
        var task = new KoraTask { Id = Guid.NewGuid().ToString("n"), RunnerId = runner.Id, Repo = repo, Prompt = prompt, From = from };
        _tasks[task.Id] = task;
        return task;
    }

    public KoraTask? Task(string taskId) => _tasks.GetValueOrDefault(taskId);

    /// <summary>
    /// Mirrors the runner's own check (kora refuses everyone else): its owner, or someone its dispatch.accept lists.
    /// </summary>
    public static bool MayUse(Runner runner, KoraUser user) =>
        runner.Owner.Sub == user.Sub
        || (runner.Registration.DispatchAccept ?? []).Any(who => who == user.Sub || who == user.Email);

    /// <summary>
    /// The GitHub repositories this user can reach through runners they may use, each with those runners
    /// (the user's own first). The PRs page lists these; the runner's gh login does the GitHub calls.
    /// </summary>
    public IReadOnlyList<PullRequestRepo> PullRequestRepos(KoraUser user) => _runners.Values
        .Where(runner => MayUse(runner, user))
        .SelectMany(runner => runner.Registration.Repos
            .Where(repo => !string.IsNullOrEmpty(repo.Github))
            .Select(repo => (Github: repo.Github!, Runner: runner, Local: repo.Local != false)))
        .GroupBy(entry => entry.Github, StringComparer.OrdinalIgnoreCase)
        .OrderBy(group => group.Key, StringComparer.OrdinalIgnoreCase)
        .Select(group => new PullRequestRepo(group.Key, group
            .DistinctBy(entry => entry.Runner.Id)
            .OrderByDescending(entry => entry.Runner.Owner.Sub == user.Sub)
            .ThenBy(entry => entry.Runner.Registration.Name)
            .Select(entry => new PullRequestRoute(entry.Runner.Id, entry.Runner.Registration.Name, entry.Runner.Owner, entry.Runner.Registration.GithubAccount, entry.Local))
            .ToList()))
        .ToList();

    public IReadOnlyList<PullRequestRoute> OwnRunners(KoraUser user) => _runners.Values
        .Where(runner => runner.Owner.Sub == user.Sub)
        .OrderBy(runner => runner.Registration.Name)
        .Select(runner => new PullRequestRoute(runner.Id, runner.Registration.Name, runner.Owner, runner.Registration.GithubAccount))
        .ToList();
}

public sealed record Runner(string Id, string ConnectionId, KoraUser Owner, RunnerRegistration Registration, DateTimeOffset ConnectedAt);
