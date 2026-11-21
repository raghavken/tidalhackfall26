`timescale 1ns/1ps
// Enforce one global ordered stream; all per-station registers are separate.
module station_demux(
    input wire clk, input wire reset_n,
    input wire [1:0] station_id, input wire [15:0] sample_index,
    input wire signed [15:0] sample_mhz, input wire sample_valid,
    input wire input_error,
    output wire accepted, output reg stream_error
);
    reg [1:0] expected_station;
    reg [16:0] expected_index; // reject wrap beyond 65535 until reset
    reg signed [15:0] latest_mhz [0:3];
    reg [16:0] accepted_count [0:3];
    reg [15:0] latest_index [0:3];
    integer k;
    assign accepted = sample_valid && !stream_error && !input_error &&
        station_id == expected_station && {1'b0,sample_index} == expected_index;
    always @(posedge clk or negedge reset_n) begin
        if(!reset_n) begin
            expected_station <= 0; expected_index <= 0; stream_error <= 0;
            for(k=0;k<4;k=k+1) begin latest_mhz[k]<=0; accepted_count[k]<=0; latest_index[k]<=0; end
        end else if(input_error || (sample_valid && !accepted)) stream_error <= 1;
        else if(accepted) begin
            latest_mhz[station_id] <= sample_mhz;
            latest_index[station_id] <= sample_index;
            accepted_count[station_id] <= accepted_count[station_id]+1'b1;
            expected_station <= expected_station+1'b1;
            if(expected_station == 3) expected_index <= expected_index+1'b1;
        end
    end
endmodule
