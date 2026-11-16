using System.Collections.Concurrent;
using System.Text.Json;

namespace DoPilot.Api.Runners;

/// <summary>
/// Merge queues of the Release > Ready to stage board: a runner merges the PRs one at a time, waiting for each merge
/// commit's build, and reports progress here for everyone watching that repository. In memory, like the runner
/// registry: the board itself lives on GitHub as labels, so a restart loses only the progress view.
/// </summary>
public sealed class ReleaseQueues
{
    private readonly ConcurrentDictionary<string, ReleaseQueue> _queues = new();
    private readonly Lock _starting = new();

    /// <summary>Adds the queue unless one is already running for the repository; returns that one instead.</summary>
    public ReleaseQueue? TryStart(ReleaseQueue queue)
    {
        lock (_starting)
        {
            var running = Active(queue.Repo);
            if (running is not null) return running;
            _queues[queue.Id] = queue;
            Trim();
            return null;
        }
    }

    public ReleaseQueue? Get(string id) => _queues.GetValueOrDefault(id);

    public void Remove(string id) => _queues.TryRemove(id, out _);

    public ReleaseQueue? Active(string repo) => ForRepo(repo).FirstOrDefault(queue => queue.Status == "running");

    public ReleaseQueue? Latest(string repo) => ForRepo(repo).FirstOrDefault();

    public IReadOnlyList<ReleaseQueue> RunningOn(string runnerId) =>
        _queues.Values.Where(queue => queue.RunnerId == runnerId && queue.Status == "running").ToList();

    private IEnumerable<ReleaseQueue> ForRepo(string repo) => _queues.Values
        .Where(queue => string.Equals(queue.Repo, repo, StringComparison.OrdinalIgnoreCase))
        .OrderByDescending(queue => queue.StartedAt);

    // Keep the latest few finished queues per repository; only the latest is ever shown.
    private void Trim()
    {
        foreach (var old in _queues.Values.GroupBy(queue => queue.Repo.ToLowerInvariant()).SelectMany(group => group.OrderByDescending(queue => queue.StartedAt).Skip(5)))
            _queues.TryRemove(old.Id, out _);
    }
}

public sealed class ReleaseQueue
{
    public required string Id { get; init; }
    public required string Repo { get; init; }
    public required string RunnerId { get; init; }
    public required string RunnerName { get; init; }
    public required KoraUser StartedBy { get; init; }
    public required string Method { get; init; }
    public required List<ReleaseQueueItem> Items { get; init; }
    public DateTimeOffset StartedAt { get; } = DateTimeOffset.UtcNow;
    public DateTimeOffset? FinishedAt { get; private set; }
    public string Status { get; private set; } = "running";

    // Set when the runner dropped off mid-queue. kora keeps going and reconnects, so its next report revives the queue.
    private bool _offline;

    /// <summary>Applies one report from the runner: { number, state, message?, commit?, runUrl?, runs? } or { done, status }.</summary>
    public void Apply(JsonElement update)
    {
        lock (Items)
        {
            if (update.TryGetProperty("done", out var done) && done.ValueKind == JsonValueKind.True)
            {
                Finish(Text(update, "status") ?? "succeeded");
                return;
            }
            if (_offline)
            {
                _offline = false;
                Status = "running";
                FinishedAt = null;
            }
            if (!update.TryGetProperty("number", out var number) || !number.TryGetInt32(out var value)) return;
            var item = Items.FirstOrDefault(entry => entry.Number == value);
            if (item is null) return;
            // Each report describes the item's current step, so its message replaces the last one.
            item.State = Text(update, "state") ?? item.State;
            item.Message = Text(update, "message");
            item.Commit = Text(update, "commit") ?? item.Commit;
            item.RunUrl = Text(update, "runUrl") ?? item.RunUrl;
            if (update.TryGetProperty("runs", out var runs) && runs.ValueKind == JsonValueKind.Array) item.Runs = runs.Clone();
        }
    }

    /// <summary>Ends the queue because its runner went offline; items not reached are marked with the reason.</summary>
    public void RunnerOffline(string reason)
    {
        lock (Items)
        {
            _offline = true;
            foreach (var item in Items.Where(entry => entry.State is "pending" or "merging" or "updating" or "building"))
            {
                item.State = item.State == "pending" ? "skipped" : "failed";
                item.Message = reason;
            }
            Finish("failed");
        }
    }

    private void Finish(string status)
    {
        Status = status;
        FinishedAt ??= DateTimeOffset.UtcNow;
    }

    public ReleaseQueueView View()
    {
        lock (Items)
        {
            return new ReleaseQueueView(Id, Repo, RunnerId, RunnerName, StartedBy, StartedAt, FinishedAt, Method, Status,
                Items.Select(item => new ReleaseQueueItemView(item.Number, item.Title, item.State, item.Message, item.Commit, item.RunUrl, item.Runs)).ToList());
        }
    }

    private static string? Text(JsonElement root, string name) =>
        root.TryGetProperty(name, out var value) && value.ValueKind == JsonValueKind.String ? value.GetString() : null;
}

/// <summary>State: pending, merging, updating (branch was behind), building, deployed, merged (no build ran), failed, skipped.</summary>
public sealed class ReleaseQueueItem
{
    public required int Number { get; init; }
    public required string Title { get; init; }
    public string State { get; set; } = "pending";
    public string? Message { get; set; }
    public string? Commit { get; set; }
    public string? RunUrl { get; set; }
    public JsonElement? Runs { get; set; }
}

public sealed record ReleaseQueueRequestItem(int Number, string Title);

public sealed record ReleaseQueueView(
    string Id,
    string Repo,
    string RunnerId,
    string RunnerName,
    KoraUser StartedBy,
    DateTimeOffset StartedAt,
    DateTimeOffset? FinishedAt,
    string Method,
    string Status,
    IReadOnlyList<ReleaseQueueItemView> Items);

public sealed record ReleaseQueueItemView(int Number, string Title, string State, string? Message, string? Commit, string? RunUrl, JsonElement? Runs);
