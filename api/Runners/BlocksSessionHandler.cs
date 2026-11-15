using System.Collections.Concurrent;
using System.Security.Claims;
using System.Security.Cryptography;
using System.Text;
using System.Text.Encodings.Web;
using System.Text.Json;
using Microsoft.AspNetCore.Authentication;
using Microsoft.Extensions.Options;

namespace DoPilot.Api.Runners;

/// <summary>
/// Authenticates the web app's browser session. Hosted Blocks login keeps the session in an httpOnly cookie on the
/// project's cookie domain, which the page cannot read, so the browser cannot send a bearer token. Instead the
/// cookies it sends here are forwarded to IAM's `GET /iam/v4/auth/me`, and IAM says who the session belongs to.
/// Only works when this service is served under the same cookie domain as the web app (e.g. *.slsblx.com).
/// </summary>
public sealed class BlocksSessionHandler(
    IOptionsMonitor<AuthenticationSchemeOptions> options,
    ILoggerFactory logger,
    UrlEncoder encoder,
    IHttpClientFactory http,
    KoraOptions kora) : AuthenticationHandler<AuthenticationSchemeOptions>(options, logger, encoder)
{
    public const string SchemeName = "BlocksSession";

    // Keyed by a hash of the cookie header, so a session is checked with IAM at most once a minute.
    private static readonly ConcurrentDictionary<string, (ClaimsPrincipal? Principal, DateTimeOffset Until)> Cache = new();
    private static readonly TimeSpan CacheFor = TimeSpan.FromMinutes(1);

    protected override async Task<AuthenticateResult> HandleAuthenticateAsync()
    {
        // Only the hub and API need a user; never ask IAM about requests for the app's files.
        if (!Request.Path.StartsWithSegments("/hubs") && !Request.Path.StartsWithSegments("/api")) return AuthenticateResult.NoResult();
        var cookies = Request.Headers.Cookie.ToString();
        if (string.IsNullOrEmpty(cookies)) return AuthenticateResult.NoResult();

        var key = Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(cookies)));
        if (!Cache.TryGetValue(key, out var cached) || cached.Until < DateTimeOffset.UtcNow)
        {
            cached = (await AskIamAsync(cookies), DateTimeOffset.UtcNow.Add(CacheFor));
            Cache[key] = cached;
            if (Cache.Count > 10_000) Cache.Clear();
        }
        return cached.Principal is null
            ? AuthenticateResult.Fail("No valid Blocks session.")
            : AuthenticateResult.Success(new AuthenticationTicket(cached.Principal, SchemeName));
    }

    private async Task<ClaimsPrincipal?> AskIamAsync(string cookies)
    {
        try
        {
            using var timeout = new CancellationTokenSource(TimeSpan.FromSeconds(5));
            using var request = new HttpRequestMessage(HttpMethod.Get, $"{kora.ApiUrl}/iam/v4/auth/me");
            request.Headers.Add("Cookie", cookies);
            request.Headers.Add("x-blocks-key", kora.TenantId);
            using var response = await http.CreateClient().SendAsync(request, timeout.Token);
            if (!response.IsSuccessStatusCode) return null;

            using var json = JsonDocument.Parse(await response.Content.ReadAsStringAsync(timeout.Token));
            var root = json.RootElement;
            var sub = Text(root, "sub");
            if (sub is null || !string.Equals(Text(root, "tenant_id"), kora.TenantId, StringComparison.OrdinalIgnoreCase)) return null;

            var claims = new List<Claim> { new("sub", KoraUser.CanonicalId(sub, Text(root, "user_id"))) };
            if (Text(root, "email") is { } email) claims.Add(new Claim("email", email));
            if ((Text(root, "name") ?? Text(root, "preferred_username")) is { } name) claims.Add(new Claim("name", name));
            return new ClaimsPrincipal(new ClaimsIdentity(claims, SchemeName, "sub", "role"));
        }
        catch (Exception error)
        {
            Logger.LogWarning("Blocks session check failed: {Error}", error.Message);
            return null;
        }
    }

    private static string? Text(JsonElement root, string name) =>
        root.TryGetProperty(name, out var value) && value.ValueKind == JsonValueKind.String ? value.GetString() : null;
}
