var express		= require( "express" ),
    weather		= require( "./routes/weather.js" ),
    cloud		= require( "./routes/cloud.js" ),
    mongoose	= require( "mongoose" ),
    Cache		= require( "./models/Cache" ),
    CronJob		= require( "cron" ).CronJob,
    net			= require( "net" ),
	port		= process.env.PORT || 3000,
	app			= express();

if ( !process.env.PORT ) {
	require( "dotenv" ).load();
}

// Connect to local MongoDB instance
mongoose.connect( "localhost" );

// If the database connection cannot be established, throw an error
mongoose.connection.on( "error", function() {
  console.error( "MongoDB Connection Error. Please make sure that MongoDB is running." );
} );

// Handle requests matching /weatherID.py where ID corresponds to the
// weather adjustment method selector.
// This endpoint is considered deprecated and supported for prior firmware
app.get( /weather(\d+)\.py/, weather.getWeather );
app.get( /(\d+)/, weather.getWeather );

// Handle 404 error
app.use( function( req, res ) {
	res.status( 404 );
	res.send( "Error: Request not found" );
} );

// Start listening on the service port
app.listen( port, "127.0.0.1", function() {

  console.log( "OpenSprinkler Weather Service now listening on port %s", port );
} );

// Start the cloud server end point
var server = net.createServer( function( socket ) {

	console.log( "Connection from " + socket.remoteAddress );
	socket.on( "data", function( data ) {
		cloud.computeSecret( data, function( hex, secret ) {
			socket.write( hex );
			console.log( hex, secret );
		} );
	} );
	socket.on( "close", function() {
		console.log( "Closed" );
	} );
} );

server.listen( 1663, function() {
	console.log( "OpenSprinkler Cloud Service now listening on port 1663." );
} );

// Schedule a cronjob daily to consildate the weather cache data, runs daily
new CronJob( "0 0 0 * * *", function() {

	// Find all records in the weather cache
	Cache.find( {}, function( err, records ) {

		if ( err ) {
			return;
		}

		// Cycle through each record
		records.forEach( function( record ) {

			// If the record contains any unaveraged data, then process the record
			if ( record.currentHumidityCount > 0 ) {

				// Average the humidity by dividing the total over the total data points collected
				record.yesterdayHumidity = record.currentHumidityTotal / record.currentHumidityCount;

				// Reset the current humidity data for the new day
				record.currentHumidityTotal = 0;
				record.currentHumidityCount = 0;

				// Save the record in the database
				record.save();
			}
		} );
	} );
}, null, true, "UTC" );

exports.app = app;
