using DoPilot.Api.Runners;
using Microsoft.AspNetCore.Authentication.JwtBearer;

var builder = WebApplication.CreateBuilder(args);
var kora = builder.Configuration.GetSection("Kora").Get<KoraOptions>()
    ?? throw new InvalidOperationException("Missing Kora configuration.");

// Runners present Blocks IAM access tokens (RS256, checked against the tenant's JWKS). The web app's browser
// session is an httpOnly cookie instead, checked with IAM by BlocksSessionHandler.
const string KoraScheme = "Kora";
builder.Services
    .AddAuthentication(KoraScheme)
    .AddPolicyScheme(KoraScheme, "Bearer token or Blocks session", options => options.ForwardDefaultSelector = context =>
        context.Request.Headers.Authorization.ToString().StartsWith("Bearer ", StringComparison.OrdinalIgnoreCase)
        || (context.Request.Path.StartsWithSegments("/hubs") && context.Request.Query.ContainsKey("access_token"))
            ? JwtBearerDefaults.AuthenticationScheme
            : BlocksSessionHandler.SchemeName)
    .AddScheme<Microsoft.AspNetCore.Authentication.AuthenticationSchemeOptions, BlocksSessionHandler>(BlocksSessionHandler.SchemeName, null)
    .AddJwtBearer(options =>
    {
        options.Authority = kora.Issuer;
        options.MapInboundClaims = false;
        options.TokenValidationParameters.ValidIssuer = kora.Issuer;
        options.TokenValidationParameters.ValidAudiences = kora.Audiences;
        options.TokenValidationParameters.NameClaimType = "sub";
        options.Events = new JwtBearerEvents
        {
            // WebSockets cannot send headers, so SignalR passes the token as ?access_token= on hub requests.
            OnMessageReceived = context =>
            {
                var token = context.Request.Query["access_token"];
                if (!string.IsNullOrEmpty(token) && context.HttpContext.Request.Path.StartsWithSegments("/hubs"))
                    context.Token = token;
                return Task.CompletedTask;
            }
        };
    });
builder.Services.AddAuthorization();
builder.Services.AddCors(options => options.AddDefaultPolicy(policy => policy
    .WithOrigins(kora.AllowedOrigins)
    .AllowAnyHeader()
    .AllowAnyMethod()
    .AllowCredentials()));
builder.Services.AddSignalR(options =>
    {
        options.MaximumReceiveMessageSize = 256 * 1024;
        // The PRs page waits on runners (gh) inside hub calls; let a slow list not hold up an approve or merge.
        options.MaximumParallelInvocationsPerClient = 4;
    })
    .AddJsonProtocol(options => options.PayloadSerializerOptions.Converters.Add(new System.Text.Json.Serialization.JsonStringEnumConverter()));
builder.Services.ConfigureHttpJsonOptions(options => options.SerializerOptions.Converters.Add(new System.Text.Json.Serialization.JsonStringEnumConverter()));
builder.Services.AddHttpClient();
builder.Services.AddSingleton(kora);
builder.Services.AddSingleton<RunnerRegistry>();
builder.Services.AddSingleton<ReleaseQueues>();
builder.Services.AddSingleton<UserDirectory>();

builder.Services.AddResponseCompression(options => options.EnableForHttps = true);
builder.Services.Configure<Microsoft.AspNetCore.ResponseCompression.BrotliCompressionProviderOptions>(options => options.Level = System.IO.Compression.CompressionLevel.Optimal);
builder.Services.Configure<Microsoft.AspNetCore.ResponseCompression.GzipCompressionProviderOptions>(options => options.Level = System.IO.Compression.CompressionLevel.Optimal);

var app = builder.Build();

// This service also serves the web app (wwwroot = the Vite build) and the KORA CLI tarballs, so the browser,
// the hub and `npm i -g <domain>/kora` all share one origin.
app.UseResponseCompression();
app.UseDefaultFiles();
app.UseStaticFiles(StaticFiles.Options);

app.UseCors();
app.UseAuthentication();
app.UseAuthorization();

app.MapGet("/healthz", () => Results.Ok(new { status = "ok" }));
app.MapGet("/api/runners", (RunnerRegistry registry) => registry.List()).RequireAuthorization();
// Diagnoses the Runners page's sign-in: which cookie NAMES reach this service (never values) and what IAM answers
// with and without the app's origin. Open it in the signed-in browser.
app.MapGet("/api/session/diagnose", async (HttpRequest request, IHttpClientFactory http, KoraOptions options) =>
{
    var cookies = request.Headers.Cookie.ToString();
    var names = cookies.Split(';', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries)
        .Select(cookie => cookie.Split('=', 2)[0]).ToArray();
    async Task<object> Ask(string? origin)
    {
        if (names.Length == 0) return "no cookies";
        try
        {
            using var timeout = new CancellationTokenSource(TimeSpan.FromSeconds(5));
            using var response = await BlocksSessionHandler.CallMeAsync(http, options, cookies, origin, timeout.Token);
            return (int)response.StatusCode;
        }
        catch (Exception error)
        {
            return error.Message;
        }
    }
    var origin = BlocksSessionHandler.AppOrigin(request, options);
    return Results.Ok(new { cookieNames = names, origin, iamWithOrigin = await Ask(origin), iamWithoutOrigin = await Ask(null) });
});
app.MapHub<RunnersHub>("/hubs/runners");
// `npm i -g https://<domain>/kora` installs the latest CLI tarball.
app.MapGet("/kora", (IWebHostEnvironment env, HttpResponse response) =>
{
    var file = env.WebRootFileProvider.GetFileInfo("kora.tgz");
    if (!file.Exists || file.PhysicalPath is null) return Results.NotFound();
    StaticFiles.SetCacheHeaders("/kora", response);
    return Results.File(file.PhysicalPath, "application/gzip", "kora.tgz");
});
app.MapFallbackToFile("index.html", StaticFiles.Options);

app.Run();
