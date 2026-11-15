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
        var orphaned = _tasks.Values.Where(t => t.RunnerId == runner.Id && t.State is KoraTaskState.Queued or KoraTaskState.Running).ToList();
        foreach (var task in orphaned) task.State = KoraTaskState.Failed;
        return (runner, orphaned);
    }

    public Runner? Get(string runnerId) => _runners.GetValueOrDefault(runnerId);

    public Runner? ByConnection(string connectionId) => _runners.Values.FirstOrDefault(r => r.ConnectionId == connectionId);

    public IReadOnlyList<RunnerView> List() => _runners.Values
        .OrderBy(r => r.Registration.Name)
        .Select(r => new RunnerView(
            r.Id, r.Registration.Name, r.Registration.Machine, r.Registration.Version, r.Owner,
            r.Registration.Repos, r.Registration.Agents, r.Registration.Concurrency,
            _tasks.Values.Count(t => t.RunnerId == r.Id && t.State is KoraTaskState.Queued or KoraTaskState.Running),
            r.ConnectedAt))
        .ToList();

    public KoraTask CreateTask(Runner runner, KoraUser from, string repo, string prompt)
    {
        var task = new KoraTask { Id = Guid.NewGuid().ToString("n"), RunnerId = runner.Id, Repo = repo, Prompt = prompt, From = from };
        _tasks[task.Id] = task;
        return task;
    }

    public KoraTask? Task(string taskId) => _tasks.GetValueOrDefault(taskId);
}

public sealed record Runner(string Id, string ConnectionId, KoraUser Owner, RunnerRegistration Registration, DateTimeOffset ConnectedAt);
